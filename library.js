'use strict';

const path = require('path');
const fs = require('fs');
const meta = require.main.require('./src/meta');
const groups = require.main.require('./src/groups');
const routeHelpers = require.main.require('./src/routes/helpers');

const controllers = require('./lib/controllers');
const nonceStore = require('./lib/nonce-store');

const plugin = {};

// Memory cache for viewer.html
let viewerHtmlCache = null;

plugin.init = async (params) => {
	const { router, middleware } = params;

	// Pre-load viewer.html into memory cache
	const viewerPath = path.join(__dirname, 'static', 'viewer.html');
	try {
		viewerHtmlCache = fs.readFileSync(viewerPath, 'utf8');
		console.log('[PDF-Secure] Viewer template cached in memory');
	} catch (err) {
		console.error('[PDF-Secure] Failed to cache viewer template:', err.message);
	}

	// Double slash bypass protection - catches /uploads//files/ attempts
	router.use((req, res, next) => {
		if (req.path.includes('//') && req.path.toLowerCase().includes('.pdf')) {
			return res.status(403).json({ error: 'Invalid path' });
		}
		next();
	});

	// PDF direct access blocker middleware
	// Intercepts requests to uploaded PDF files and returns 403
	// Admin and Global Moderators can bypass this restriction
	router.get('/assets/uploads/files/:filename', async (req, res, next) => {
		if (req.params.filename && req.params.filename.toLowerCase().endsWith('.pdf')) {
			// Admin ve Global Mod'lar direkt erişebilsin
			if (req.uid) {
				const [isAdmin, isGlobalMod] = await Promise.all([
					groups.isMember(req.uid, 'administrators'),
					groups.isMember(req.uid, 'Global Moderators'),
				]);
				if (isAdmin || isGlobalMod) {
					return next();
				}
			}
			return res.status(403).json({ error: 'Direct PDF access is not allowed. Use the secure viewer.' });
		}
		next();
	});

	// PDF binary endpoint (nonce-validated, guests allowed)
	router.get('/api/v3/plugins/pdf-secure/pdf-data', controllers.servePdfBinary);

	// Admin page route
	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/pdf-secure', controllers.renderAdminPage);

	// Viewer page route (fullscreen Mozilla PDF.js viewer, guests allowed)
	router.get('/plugins/pdf-secure/viewer', (req, res) => {
		const { file } = req.query;
		if (!file) {
			return res.status(400).send('Missing file parameter');
		}

		// Sanitize filename
		const safeName = path.basename(file);
		if (!safeName || !safeName.toLowerCase().endsWith('.pdf')) {
			return res.status(400).send('Invalid file');
		}

		// Check cache
		if (!viewerHtmlCache) {
			return res.status(500).send('Viewer not available');
		}

		// Generate nonce + key HERE (in viewer route)
		// This way the key is ONLY embedded in HTML, never in a separate API response
		const isPremium = true;
		const nonceData = nonceStore.generate(req.uid || 0, safeName, isPremium);

		// Serve the viewer template with comprehensive security headers
		res.set({
			'X-Frame-Options': 'SAMEORIGIN',
			'X-Content-Type-Options': 'nosniff',
			'X-XSS-Protection': '1; mode=block',
			'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
			'Pragma': 'no-cache',
			'Expires': '0',
			'Referrer-Policy': 'no-referrer',
			'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
			'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'",
		});

		// Inject the filename, nonce, and key into the cached viewer
		// Key is embedded in HTML - NOT visible in any network API response!
		const injectedHtml = viewerHtmlCache
			.replace('</head>', `
				<style>
					/* Hide upload overlay since PDF will auto-load */
					#uploadOverlay { display: none !important; }
				</style>
				<script>
					window.PDF_SECURE_CONFIG = {
						filename: ${JSON.stringify(safeName)},
						relativePath: ${JSON.stringify(req.app.get('relative_path') || '')},
						csrfToken: ${JSON.stringify(req.csrfToken ? req.csrfToken() : '')},
						nonce: ${JSON.stringify(nonceData.nonce)},
						dk: ${JSON.stringify(nonceData.xorKey)}
					};
				</script>
			</head>`);

		res.type('html').send(injectedHtml);
	});
};

plugin.addRoutes = async ({ router, middleware, helpers }) => {
	// Nonce endpoint removed - nonce is now generated in viewer route
	// This improves security by not exposing any key-related data in API responses
};

plugin.addAdminNavigation = (header) => {
	header.plugins.push({
		route: '/plugins/pdf-secure',
		icon: 'fa-file-pdf-o',
		name: 'PDF Secure Viewer',
	});

	return header;
};

// Filter meta tags to hide PDF URLs and filenames
plugin.filterMetaTags = async (hookData) => {
	if (!hookData || !hookData.tags) {
		return hookData;
	}

	// Admin/Global Moderator bypass - no filtering for privileged users
	if (hookData.req && hookData.req.uid) {
		const [isAdmin, isGlobalMod] = await Promise.all([
			groups.isMember(hookData.req.uid, 'administrators'),
			groups.isMember(hookData.req.uid, 'Global Moderators'),
		]);
		if (isAdmin || isGlobalMod) {
			return hookData;
		}
	}

	// Filter out PDF-related meta tags
	hookData.tags = hookData.tags.filter(tag => {
		// Remove og:image and og:image:url if it contains .pdf
		if ((tag.property === 'og:image' || tag.property === 'og:image:url') && tag.content && tag.content.toLowerCase().includes('.pdf')) {
			return false;
		}
		// Remove twitter:image if it contains .pdf
		if (tag.name === 'twitter:image' && tag.content && tag.content.toLowerCase().includes('.pdf')) {
			return false;
		}
		return true;
	});

	// Sanitize description to hide .pdf extensions
	hookData.tags = hookData.tags.map(tag => {
		if ((tag.name === 'description' || tag.property === 'og:description') && tag.content) {
			// Replace .pdf extension with empty string in description
			tag.content = tag.content.replace(/\.pdf/gi, '');
		}
		return tag;
	});

	return hookData;
};

// Transform PDF links to secure placeholders (server-side)
// This hides PDF URLs from: page source, API, RSS, ActivityPub
plugin.transformPdfLinks = async (data) => {
	if (!data || !data.postData || !data.postData.content) {
		return data;
	}

	// Regex to match PDF links: <a href="...xxx.pdf">text</a>
	// Captures: full URL path, filename, link text
	const pdfLinkRegex = /<a\s+[^>]*href=["']([^"']*\/([^"'\/]+\.pdf))["'][^>]*>([^<]*)<\/a>/gi;

	data.postData.content = data.postData.content.replace(pdfLinkRegex, (match, fullPath, filename, linkText) => {
		// Decode filename to prevent double encoding (URL may already be encoded)
		let decodedFilename;
		try { decodedFilename = decodeURIComponent(filename); }
		catch (e) { decodedFilename = filename; }

		// Sanitize for HTML attribute
		const safeFilename = decodedFilename.replace(/[<>"'&]/g, '');
		const displayName = linkText.trim() || safeFilename;

		// Return secure placeholder div instead of actual link
		return `<div class="pdf-secure-placeholder" data-filename="${safeFilename}">
			<svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:#e81224;vertical-align:middle;margin-right:8px;">
				<path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/>
			</svg>
			<span>${displayName}</span>
		</div>`;
	});

	return data;
};

module.exports = plugin;
