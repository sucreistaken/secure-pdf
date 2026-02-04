'use strict';

const crypto = require('crypto');
const winston = require.main.require('winston');
const meta = require.main.require('./src/meta');
const user = require.main.require('./src/user');
const groups = require.main.require('./src/groups');

const controllers = require('./lib/controllers');
const routeHelpers = require.main.require('./src/routes/helpers');

// Polyfill DOMMatrix and Path2D for pdfjs-dist server-side rendering
const napiCanvas = require('@napi-rs/canvas');
if (typeof globalThis.DOMMatrix === 'undefined') {
	globalThis.DOMMatrix = napiCanvas.DOMMatrix;
}
if (typeof globalThis.Path2D === 'undefined') {
	globalThis.Path2D = napiCanvas.Path2D;
}

const plugin = {};

// Token storage (in production, use Redis)
const tokenStore = new Map();
const TOKEN_EXPIRY_MS = 600000; // 10 minutes — enough time to read comfortably
const ALLOWED_GROUP = 'Premium';

// Rate limiting storage
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute window
const MAX_TOKEN_REQUESTS = 20; // Max 20 token requests per minute per user
const MAX_PAGE_REQUESTS = 50; // Max 50 page requests per minute per user
const MAX_PAGES_PER_TOKEN = 200; // Max page requests per token (covers back-and-forth browsing)

/**
 * Check rate limit for a user action
 * @returns {boolean} true if rate limited, false if allowed
 */
function isRateLimited(uid, action) {
	const key = `${uid}:${action}`;
	const now = Date.now();
	const limit = action === 'token' ? MAX_TOKEN_REQUESTS : MAX_PAGE_REQUESTS;

	if (!rateLimitStore.has(key)) {
		rateLimitStore.set(key, { count: 1, windowStart: now });
		return false;
	}

	const data = rateLimitStore.get(key);

	// Reset window if expired
	if (now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
		rateLimitStore.set(key, { count: 1, windowStart: now });
		return false;
	}

	// Check if over limit
	if (data.count >= limit) {
		return true;
	}

	// Increment counter
	data.count += 1;
	return false;
}

// ==========================================
// BACKGROUND RENDER QUEUE SYSTEM
// PDF pages rendered server-side to PNG and cached
// Same PDF/page combination served to all users from cache
// ==========================================
const pageCache = new Map(); // Stores rendered PNG buffers
const pdfDocCache = new Map(); // Stores loaded PDF document objects
const pendingRenders = new Map(); // In-flight render promises (prevents thundering herd)
const pendingDocs = new Map(); // In-flight PDF load promises
const PAGE_CACHE_TTL = 1800000; // 30 min
const PDF_DOC_CACHE_TTL = 3600000; // 1 hour
const MAX_CACHED_PAGES = 500; // LRU limit — ~500MB-1GB max memory
const CLEANUP_INTERVAL_MS = 300000; // 5 minutes — periodic cleanup of expired entries
const PRE_WARM_PAGES = 5; // Only pre-render first 5 pages, rest loaded on-demand via scroll
const MAX_CONCURRENT_RENDERS = 4; // Max simultaneous render operations to prevent CPU saturation
let activeRenders = 0; // Current number of in-flight renders
const renderQueue = []; // Queued render jobs waiting for a slot

// Periodic cleanup of expired entries to prevent memory leaks
setInterval(() => {
	const now = Date.now();

	// Clean expired rate limit entries
	for (const [key, data] of rateLimitStore) {
		if (now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
			rateLimitStore.delete(key);
		}
	}

	// Clean expired PDF document cache entries
	for (const [key, data] of pdfDocCache) {
		if (now > data.expires) {
			pdfDocCache.delete(key);
		}
	}

	// Clean expired page cache entries
	for (const [key, data] of pageCache) {
		if (now > data.expires) {
			pageCache.delete(key);
		}
	}
}, CLEANUP_INTERVAL_MS);

/**
 * Get or load a PDF document (cached, with promise coalescing)
 * 500 concurrent requests for the same PDF = 1 download
 */
function getPdfDocument(pdfUrl) {
	const cached = pdfDocCache.get(pdfUrl);
	if (cached && Date.now() < cached.expires) {
		return Promise.resolve(cached.doc);
	}

	// If already loading this PDF, return the same promise
	if (pendingDocs.has(pdfUrl)) {
		return pendingDocs.get(pdfUrl);
	}

	const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
	const promise = pdfjsLib.getDocument({
		url: pdfUrl,
		disableFontFace: true,
		useSystemFonts: true,
	}).promise.then((pdfDoc) => {
		pdfDocCache.set(pdfUrl, {
			doc: pdfDoc,
			expires: Date.now() + PDF_DOC_CACHE_TTL,
		});
		pendingDocs.delete(pdfUrl);
		return pdfDoc;
	}).catch((err) => {
		pendingDocs.delete(pdfUrl);
		throw err;
	});

	pendingDocs.set(pdfUrl, promise);
	return promise;
}

/**
 * Acquire a render slot (semaphore). Resolves when a slot is available.
 * Max MAX_CONCURRENT_RENDERS can run simultaneously — prevents CPU saturation.
 */
function acquireRenderSlot() {
	if (activeRenders < MAX_CONCURRENT_RENDERS) {
		activeRenders += 1;
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		renderQueue.push(resolve);
	});
}

/**
 * Release a render slot, allowing the next queued render to proceed.
 */
function releaseRenderSlot() {
	if (renderQueue.length > 0) {
		const next = renderQueue.shift();
		next();
	} else {
		activeRenders -= 1;
	}
}

/**
 * Render a PDF page to PNG buffer (expensive CPU operation)
 * Guarded by semaphore — max MAX_CONCURRENT_RENDERS at once
 */
async function renderBasePage(pdfUrl, pageNum) {
	const { createCanvas } = require('@napi-rs/canvas');
	const pdfDoc = await getPdfDocument(pdfUrl);

	if (pageNum < 1 || pageNum > pdfDoc.numPages) {
		throw new Error('Invalid page number');
	}

	await acquireRenderSlot();
	try {
		const pdfPage = await pdfDoc.getPage(pageNum);
		const scale = 2.0;
		const viewport = pdfPage.getViewport({ scale });

		const canvas = createCanvas(viewport.width, viewport.height);
		const context = canvas.getContext('2d');

		await pdfPage.render({
			canvasContext: context,
			viewport: viewport,
		}).promise;

		return canvas.toBuffer('image/png');
	} finally {
		releaseRenderSlot();
	}
}

/**
 * Evict expired and oldest entries when cache exceeds limit
 */
function evictCache() {
	const now = Date.now();

	// First pass: remove expired entries
	for (const [key, value] of pageCache) {
		if (now > value.expires) {
			pageCache.delete(key);
		}
	}

	// Second pass: if still over limit, evict oldest (Map preserves insertion order)
	if (pageCache.size > MAX_CACHED_PAGES) {
		const toRemove = pageCache.size - MAX_CACHED_PAGES;
		let removed = 0;
		for (const [key] of pageCache) {
			if (removed >= toRemove) break;
			pageCache.delete(key);
			removed += 1;
		}
	}

	winston.verbose(`[secure-pdf] Cache eviction: ${pageCache.size} pages remaining`);
}

/**
 * Get a rendered page with promise coalescing
 * 500 concurrent requests for the same uncached page = 1 render
 * All 500 requests await the same promise and get the same result
 */
function getCachedPage(pdfUrl, pageNum) {
	const cacheKey = `${pdfUrl}:${pageNum}`;

	// 1. Try cache — re-insert to mark as recently used (LRU)
	const cached = pageCache.get(cacheKey);
	if (cached && Date.now() < cached.expires) {
		// Move to end (most recently used) by re-inserting
		pageCache.delete(cacheKey);
		pageCache.set(cacheKey, cached);
		return Promise.resolve(cached.data);
	}
	if (cached) {
		pageCache.delete(cacheKey);
	}

	// 2. If already rendering this page, piggyback on the existing promise
	if (pendingRenders.has(cacheKey)) {
		return pendingRenders.get(cacheKey);
	}

	// 3. Render and cache — only 1 render per unique page
	const promise = renderBasePage(pdfUrl, pageNum).then((buffer) => {
		pageCache.set(cacheKey, {
			data: buffer,
			expires: Date.now() + PAGE_CACHE_TTL,
		});
		pendingRenders.delete(cacheKey);
		evictCache();
		return buffer;
	}).catch((err) => {
		pendingRenders.delete(cacheKey);
		throw err;
	});

	pendingRenders.set(cacheKey, promise);
	return promise;
}

/**
 * Pre-warm cache with first N pages of a PDF (fire-and-forget)
 * Only renders PRE_WARM_PAGES pages — the rest are loaded on-demand via scroll
 * Semaphore in renderBasePage prevents CPU saturation
 */
function preWarmCache(pdfUrl, numPages) {
	const pagesToWarm = Math.min(numPages, PRE_WARM_PAGES);
	for (let i = 1; i <= pagesToWarm; i += 1) {
		getCachedPage(pdfUrl, i).catch(() => {});
	}
}

/**
 * Validate PDF URL to prevent SSRF attacks
 * Blocks: file://, internal IPs, localhost, cloud metadata endpoints
 */
function isValidPdfUrl(pdfUrl) {
	let parsed;
	try {
		parsed = new URL(pdfUrl);
	} catch {
		return false;
	}

	// Only allow HTTP(S)
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return false;
	}

	const hostname = parsed.hostname.toLowerCase();

	// Block localhost variants
	if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
		return false;
	}

	// Block private/internal IP ranges
	const parts = hostname.split('.');
	if (parts.length === 4) {
		const first = parseInt(parts[0], 10);
		const second = parseInt(parts[1], 10);
		if (first === 10) return false; // 10.0.0.0/8
		if (first === 172 && second >= 16 && second <= 31) return false; // 172.16.0.0/12
		if (first === 192 && second === 168) return false; // 192.168.0.0/16
		if (first === 169 && second === 254) return false; // 169.254.0.0/16 (AWS metadata)
	}

	return true;
}

/**
 * Generate a secure token for PDF access, bound to session and IP
 */
function generateToken(uid, pdfUrl, sessionId, ip) {
	const token = crypto.randomBytes(32).toString('hex');
	const expires = Date.now() + TOKEN_EXPIRY_MS;

	tokenStore.set(token, {
		uid,
		pdfUrl,
		sessionId,
		ip,
		expires,
		pageRequests: 0,
	});

	// Cleanup handled by:
	// - validateToken() deletes on expiry check
	// - Periodic setInterval cleanup every 5 minutes

	return token;
}

/**
 * Validate a token, checking session and IP binding
 * @param {object} options - { countPage: boolean } — set countPage to false for info-only requests
 */
function validateToken(token, sessionId, ip, options) {
	const countPage = !options || options.countPage !== false;
	const data = tokenStore.get(token);

	if (!data) {
		return { valid: false, reason: 'Token not found' };
	}

	if (Date.now() > data.expires) {
		tokenStore.delete(token);
		return { valid: false, reason: 'Token expired' };
	}

	// Check session binding
	if (data.sessionId && data.sessionId !== sessionId) {
		return { valid: false, reason: 'Session mismatch' };
	}

	// Check IP binding
	if (data.ip && data.ip !== ip) {
		return { valid: false, reason: 'IP mismatch' };
	}

	// Sliding expiry: reset timer on each valid request
	data.expires = Date.now() + TOKEN_EXPIRY_MS;

	if (countPage) {
		// Check page request limit
		if (data.pageRequests >= MAX_PAGES_PER_TOKEN) {
			return { valid: false, reason: 'Page limit exceeded, request new token' };
		}

		// Increment page request counter
		data.pageRequests += 1;
	}

	return { valid: true, data };
}

/**
 * Check if user has permission to view premium content
 */
async function checkPremiumAccess(uid) {
	if (!uid || uid <= 0) {
		return false;
	}

	// Admins always have access
	const isAdmin = await user.isAdministrator(uid);
	if (isAdmin) {
		return true;
	}

	// Check Premium group membership
	const isMember = await groups.isMember(uid, ALLOWED_GROUP);
	return isMember;
}

/**
 * Plugin initialization
 */
plugin.init = async (params) => {
	const { router } = params;

	winston.info('[plugins/secure-pdf] Initializing Secure PDF Viewer...');

	// Load settings (used for future admin config)
	await meta.settings.get('secure-pdf');

	// Setup viewer page route
	routeHelpers.setupPageRoute(router, '/pdf-viewer', [], (req, res) => {
		res.render('secure-pdf/viewer', { uid: req.uid });
	});

	// Admin page
	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/secure-pdf', controllers.renderAdminPage);

	winston.info('[plugins/secure-pdf] Secure PDF Viewer initialized successfully');
};

/**
 * API Routes for PDF token and page rendering
 */
plugin.addRoutes = async ({ router, middleware, helpers }) => {
	const middlewares = [
		middleware.ensureLoggedIn,
	];

	// Generate token for PDF access
	routeHelpers.setupApiRoute(router, 'post', '/secure-pdf/token', middlewares, async (req, res) => {
		try {
			const { pdfUrl } = req.body;
			const {uid} = req;

			// Rate limit check
			if (isRateLimited(uid, 'token')) {
				winston.warn(`[plugins/secure-pdf] Rate limited user ${uid} for token requests`);
				return helpers.formatApiResponse(429, res, { error: 'Too many requests. Please wait.' });
			}

			if (!pdfUrl) {
				return helpers.formatApiResponse(400, res, { error: 'PDF URL required' });
			}

			// SSRF protection: block internal/private URLs
			if (!isValidPdfUrl(pdfUrl)) {
				return helpers.formatApiResponse(400, res, { error: 'Invalid PDF URL' });
			}

			// Check premium access
			const hasAccess = await checkPremiumAccess(uid);

			// Generate token bound to session and IP
			const sessionId = req.sessionID || (req.session && req.session.id) || '';
			const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
			const token = generateToken(uid, pdfUrl, sessionId, ip);

			helpers.formatApiResponse(200, res, {
				token,
				hasFullAccess: hasAccess,
				freePageLimit: hasAccess ? -1 : 1,
			});
		} catch (err) {
			winston.error('[plugins/secure-pdf] Token generation error:', err);
			helpers.formatApiResponse(500, res, { error: 'Internal error' });
		}
	});

	// ==========================================
	// SECURE PAGE RENDERING - PDF NEVER SENT TO CLIENT
	// ==========================================

	routeHelpers.setupApiRoute(router, 'get', '/secure-pdf/page', middlewares, async (req, res) => {
		try {
			const { token, page } = req.query;
			const {uid} = req;
			const pageNum = parseInt(page) || 1;

			// Rate limit check
			if (isRateLimited(uid, 'page')) {
				return helpers.formatApiResponse(429, res, { error: 'Too many requests' });
			}

			if (!token) {
				return helpers.formatApiResponse(400, res, { error: 'Token required' });
			}

			// Validate token with session/IP check and page limit
			const sessionId = req.sessionID || (req.session && req.session.id) || '';
			const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
			const validation = validateToken(token, sessionId, ip);

			if (!validation.valid) {
				return helpers.formatApiResponse(403, res, { error: validation.reason });
			}

			const { pdfUrl } = validation.data;

			// Get page from cache or render it (single render shared across all users)
			const pngBuffer = await getCachedPage(pdfUrl, pageNum);

			// Security headers - prevent caching and downloading
			res.setHeader('Content-Type', 'image/png');
			res.setHeader('Content-Disposition', 'inline');
			res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
			res.setHeader('Pragma', 'no-cache');
			res.setHeader('Expires', '0');
			res.setHeader('X-Content-Type-Options', 'nosniff');
			res.setHeader('X-Frame-Options', 'SAMEORIGIN');
			res.send(pngBuffer);

		} catch (err) {
			winston.error('[plugins/secure-pdf] Page render error:', err);
			if (!res.headersSent) {
				helpers.formatApiResponse(500, res, { error: 'Render error' });
			}
		}
	});

	// Get PDF info (page count) without exposing the PDF
	routeHelpers.setupApiRoute(router, 'get', '/secure-pdf/info', middlewares, async (req, res) => {
		try {
			const { token } = req.query;

			if (!token) {
				return helpers.formatApiResponse(400, res, { error: 'Token required' });
			}

			// Validate token with session/IP check (don't count as page request)
			const sessionId = req.sessionID || (req.session && req.session.id) || '';
			const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
			const validation = validateToken(token, sessionId, ip, { countPage: false });

			if (!validation.valid) {
				return helpers.formatApiResponse(403, res, { error: validation.reason });
			}

			const { pdfUrl } = validation.data;

			// Get PDF info (uses cached document)
			const pdfDoc = await getPdfDocument(pdfUrl);

			// Pre-warm cache with first pages
			preWarmCache(pdfUrl, pdfDoc.numPages);

			helpers.formatApiResponse(200, res, {
				numPages: pdfDoc.numPages,
				token: token, // Return same token for subsequent requests
			});

		} catch (err) {
			winston.error('[plugins/secure-pdf] Info error:', err);
			helpers.formatApiResponse(500, res, { error: 'Info error' });
		}
	});
};

/**
 * Admin navigation
 */
plugin.addAdminNavigation = (header) => {
	header.plugins.push({
		route: '/plugins/secure-pdf',
		icon: 'fa-file-pdf-o',
		name: 'Secure PDF Viewer',
	});

	return header;
};

module.exports = plugin;
