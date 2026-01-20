'use strict';

const crypto = require('crypto');
const nconf = require.main.require('nconf');
const winston = require.main.require('winston');
const meta = require.main.require('./src/meta');
const user = require.main.require('./src/user');
const groups = require.main.require('./src/groups');

const controllers = require('./lib/controllers');
const routeHelpers = require.main.require('./src/routes/helpers');

const plugin = {};

// Token storage (in production, use Redis)
const tokenStore = new Map();
const TOKEN_EXPIRY_MS = 60000; // 60 seconds
const ALLOWED_GROUP = 'Premium';

/**
 * Generate a secure one-time token for PDF access
 */
function generateToken(uid, pdfUrl) {
	const token = crypto.randomBytes(32).toString('hex');
	const expires = Date.now() + TOKEN_EXPIRY_MS;

	tokenStore.set(token, {
		uid,
		pdfUrl,
		expires,
		used: false
	});

	// Auto-cleanup expired tokens
	setTimeout(() => {
		tokenStore.delete(token);
	}, TOKEN_EXPIRY_MS + 1000);

	return token;
}

/**
 * Validate and consume a token
 */
function validateToken(token) {
	const data = tokenStore.get(token);

	if (!data) {
		return { valid: false, reason: 'Token not found' };
	}

	if (data.used) {
		return { valid: false, reason: 'Token already used' };
	}

	if (Date.now() > data.expires) {
		tokenStore.delete(token);
		return { valid: false, reason: 'Token expired' };
	}

	// Mark as used (one-time use)
	data.used = true;

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

	// Load settings
	const settings = await meta.settings.get('secure-pdf');

	// Setup viewer page route
	routeHelpers.setupPageRoute(router, '/pdf-viewer', [], (req, res) => {
		res.render('secure-pdf/viewer', { uid: req.uid });
	});

	// Admin page
	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/secure-pdf', controllers.renderAdminPage);

	winston.info('[plugins/secure-pdf] Secure PDF Viewer initialized successfully');
};

/**
 * API Routes for PDF token and streaming
 */
plugin.addRoutes = async ({ router, middleware, helpers }) => {
	const middlewares = [
		middleware.ensureLoggedIn
	];

	// Generate token for PDF access
	routeHelpers.setupApiRoute(router, 'post', '/secure-pdf/token', middlewares, async (req, res) => {
		try {
			const { pdfUrl } = req.body;
			const uid = req.uid;

			if (!pdfUrl) {
				return helpers.formatApiResponse(400, res, { error: 'PDF URL required' });
			}

			// Check premium access
			const hasAccess = await checkPremiumAccess(uid);

			// Generate token
			const token = generateToken(uid, pdfUrl);

			// Get username for watermark
			const userData = await user.getUserData(uid);

			helpers.formatApiResponse(200, res, {
				token,
				hasFullAccess: hasAccess,
				freePageLimit: hasAccess ? -1 : 1,
				watermark: userData.username,
				expiresIn: TOKEN_EXPIRY_MS
			});
		} catch (err) {
			winston.error('[plugins/secure-pdf] Token generation error:', err);
			helpers.formatApiResponse(500, res, { error: 'Internal error' });
		}
	});

	// Stream PDF with token validation
	routeHelpers.setupApiRoute(router, 'get', '/secure-pdf/stream', middlewares, async (req, res) => {
		try {
			const { token } = req.query;

			if (!token) {
				return helpers.formatApiResponse(400, res, { error: 'Token required' });
			}

			// Validate token
			const validation = validateToken(token);

			if (!validation.valid) {
				return helpers.formatApiResponse(403, res, { error: validation.reason });
			}

			const { pdfUrl } = validation.data;

			// In production, fetch the PDF and stream it
			// For now, redirect to the actual URL (less secure but simpler)
			// TODO: Implement proper streaming with watermark injection

			res.redirect(pdfUrl);

		} catch (err) {
			winston.error('[plugins/secure-pdf] Stream error:', err);
			helpers.formatApiResponse(500, res, { error: 'Stream error' });
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
		name: 'Secure PDF Viewer'
	});

	return header;
};

module.exports = plugin;
