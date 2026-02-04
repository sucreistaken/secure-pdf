'use strict';

/**
 * Standalone unit tests for Secure PDF Plugin
 * Run: node test/unit.js
 *
 * Mocks NodeBB dependencies and tests:
 * - Plugin structure & exports
 * - Admin navigation
 * - API route registration (stream endpoint removed)
 * - Token generation (64-char hex, session/IP binding)
 * - Token validation (session mismatch, IP mismatch, invalid token)
 * - Info endpoint does NOT consume page quota
 * - Rate limiting
 * - Input validation
 */

// ==========================================
// MOCKS
// ==========================================

const mockWinston = {
	info: () => {},
	warn: () => {},
	error: () => {},
	verbose: () => {},
};

const mockMeta = {
	settings: {
		get: async () => ({}),
	},
};

const mockUser = {
	isAdministrator: async () => false,
};

const mockGroups = {
	isMember: async () => false,
};

const mockRouteHelpers = {
	setupPageRoute: () => {},
	setupAdminPageRoute: () => {},
	setupApiRoute: (router, method, routePath, _middlewares, handler) => {
		router._routes = router._routes || {};
		router._routes[`${method}:${routePath}`] = handler;
	},
};

// Override require.main.require before loading library
const origMainRequire = require.main.require.bind(require.main);
require.main.require = function (id) {
	const mocks = {
		winston: mockWinston,
		'./src/meta': mockMeta,
		'./src/user': mockUser,
		'./src/groups': mockGroups,
		'./src/routes/helpers': mockRouteHelpers,
	};
	if (id in mocks) return mocks[id];
	return origMainRequire(id);
};

// Load the plugin
const plugin = require('../library');

// ==========================================
// TEST RUNNER
// ==========================================

let passed = 0;
let failed = 0;

function assert(condition, message) {
	if (condition) {
		passed += 1;
		console.log(`  \u2713 ${message}`);
	} else {
		failed += 1;
		console.error(`  \u2717 ${message}`);
	}
}

async function runTests() {
	console.log('\n=== Secure PDF Plugin - Unit Tests ===\n');

	// ------- Plugin Structure -------
	console.log('Plugin Structure:');
	assert(typeof plugin.init === 'function', 'plugin.init is a function');
	assert(typeof plugin.addRoutes === 'function', 'plugin.addRoutes is a function');
	assert(typeof plugin.addAdminNavigation === 'function', 'plugin.addAdminNavigation is a function');

	// ------- Admin Navigation -------
	console.log('\nAdmin Navigation:');
	const header = { plugins: [] };
	const result = plugin.addAdminNavigation(header);
	assert(result.plugins.length === 1, 'adds one plugin to navigation');
	assert(result.plugins[0].route === '/plugins/secure-pdf', 'correct route path');
	assert(result.plugins[0].name === 'Secure PDF Viewer', 'correct display name');

	const header2 = { plugins: [{ route: '/existing' }] };
	const result2 = plugin.addAdminNavigation(header2);
	assert(result2.plugins.length === 2, 'appends to existing plugins without replacing');

	// ------- API Route Registration -------
	console.log('\nAPI Routes:');
	const mockRouter = { _routes: {} };
	const mockMiddleware = { ensureLoggedIn: () => {} };
	const mockHelpers = {
		formatApiResponse: (code, res, data) => {
			res._status = code;
			res._data = data;
		},
	};

	await plugin.addRoutes({ router: mockRouter, middleware: mockMiddleware, helpers: mockHelpers });

	assert('post:/secure-pdf/token' in mockRouter._routes, 'POST /secure-pdf/token registered');
	assert('get:/secure-pdf/page' in mockRouter._routes, 'GET /secure-pdf/page registered');
	assert('get:/secure-pdf/info' in mockRouter._routes, 'GET /secure-pdf/info registered');
	assert(!('get:/secure-pdf/stream' in mockRouter._routes), 'Stream endpoint NOT registered (removed for security)');

	const tokenHandler = mockRouter._routes['post:/secure-pdf/token'];
	const pageHandler = mockRouter._routes['get:/secure-pdf/page'];
	const infoHandler = mockRouter._routes['get:/secure-pdf/info'];

	// ------- Token Generation -------
	console.log('\nToken Generation:');
	mockUser.isAdministrator = async (uid) => uid === 1;

	const tokenReq = {
		uid: 1,
		body: { pdfUrl: 'https://example.com/test.pdf' },
		sessionID: 'session-abc',
		ip: '127.0.0.1',
	};
	const tokenRes = {};
	await tokenHandler(tokenReq, tokenRes);

	assert(tokenRes._status === 200, 'returns 200 on success');
	assert(tokenRes._data && typeof tokenRes._data.token === 'string', 'response contains token string');
	assert(tokenRes._data.token.length === 64, 'token is 64-char hex (32 bytes)');
	assert(tokenRes._data.hasFullAccess === true, 'admin user has full access');

	const token1 = tokenRes._data.token;

	// Non-admin, non-premium user
	mockUser.isAdministrator = async () => false;
	mockGroups.isMember = async () => false;

	const tokenReq2 = {
		uid: 2,
		body: { pdfUrl: 'https://example.com/test.pdf' },
		sessionID: 'session-xyz',
		ip: '10.0.0.1',
	};
	const tokenRes2 = {};
	await tokenHandler(tokenReq2, tokenRes2);

	assert(tokenRes2._data.hasFullAccess === false, 'non-premium user does NOT have full access');
	assert(tokenRes2._data.freePageLimit === 1, 'free user gets freePageLimit=1');

	const token2 = tokenRes2._data.token;

	// ------- Token Validation: Session Mismatch -------
	console.log('\nToken Validation - Session Binding:');
	const sessionMismatchRes = {};
	await pageHandler(
		{ uid: 1, query: { token: token1, page: '1' }, sessionID: 'wrong-session', ip: '127.0.0.1' },
		sessionMismatchRes,
	);
	assert(sessionMismatchRes._status === 403, 'session mismatch returns 403');

	// ------- Token Validation: IP Mismatch -------
	console.log('\nToken Validation - IP Binding:');
	const ipMismatchRes = {};
	await pageHandler(
		{ uid: 1, query: { token: token1, page: '1' }, sessionID: 'session-abc', ip: '192.168.1.1' },
		ipMismatchRes,
	);
	assert(ipMismatchRes._status === 403, 'IP mismatch returns 403');

	// ------- Token Validation: Invalid Token -------
	console.log('\nToken Validation - Invalid Token:');
	const invalidRes = {};
	await pageHandler(
		{ uid: 1, query: { token: 'nonexistent-token', page: '1' }, sessionID: 'session-abc', ip: '127.0.0.1' },
		invalidRes,
	);
	assert(invalidRes._status === 403, 'invalid token returns 403');

	// ------- SSRF Protection -------
	console.log('\nSSRF Protection:');
	const ssrfTests = [
		['http://localhost/secret.pdf', 'blocks localhost'],
		['http://127.0.0.1/secret.pdf', 'blocks 127.0.0.1'],
		['http://0.0.0.0/secret.pdf', 'blocks 0.0.0.0'],
		['http://10.0.0.1/internal.pdf', 'blocks 10.x.x.x (private)'],
		['http://172.16.0.1/internal.pdf', 'blocks 172.16.x.x (private)'],
		['http://192.168.1.1/internal.pdf', 'blocks 192.168.x.x (private)'],
		['http://169.254.169.254/latest/meta-data/', 'blocks AWS metadata'],
		['file:///etc/passwd', 'blocks file:// protocol'],
		['ftp://example.com/file.pdf', 'blocks ftp:// protocol'],
	];

	for (const [url, label] of ssrfTests) {
		const ssrfRes = {};
		await tokenHandler({ uid: 1, body: { pdfUrl: url }, sessionID: 's', ip: '1.1.1.1' }, ssrfRes);
		assert(ssrfRes._status === 400, label);
	}

	// Valid URLs should pass
	const validUrlRes = {};
	await tokenHandler(
		{ uid: 1, body: { pdfUrl: 'https://cdn.example.com/docs/book.pdf' }, sessionID: 's', ip: '1.1.1.1' },
		validUrlRes,
	);
	assert(validUrlRes._status === 200, 'allows valid HTTPS URL');

	// ------- Input Validation -------
	console.log('\nInput Validation:');
	const noUrlRes = {};
	await tokenHandler({ uid: 1, body: {}, sessionID: 's', ip: '1.1.1.1' }, noUrlRes);
	assert(noUrlRes._status === 400, 'missing pdfUrl returns 400');

	const noTokenPageRes = {};
	await pageHandler({ uid: 1, query: {}, sessionID: 's', ip: '1.1.1.1' }, noTokenPageRes);
	assert(noTokenPageRes._status === 400, 'missing token on page endpoint returns 400');

	const noTokenInfoRes = {};
	await infoHandler({ uid: 1, query: {}, sessionID: 's', ip: '1.1.1.1' }, noTokenInfoRes);
	assert(noTokenInfoRes._status === 400, 'missing token on info endpoint returns 400');

	// ------- Info Endpoint: Page Quota Not Consumed -------
	console.log('\nInfo Endpoint - Page Quota:');
	// Generate a fresh token
	mockUser.isAdministrator = async () => true;
	const quotaReq = {
		uid: 50,
		body: { pdfUrl: 'https://example.com/quota-test.pdf' },
		sessionID: 'session-quota',
		ip: '10.0.0.50',
	};
	const quotaTokenRes = {};
	await tokenHandler(quotaReq, quotaTokenRes);
	const quotaToken = quotaTokenRes._data.token;

	// Call info multiple times — should NOT consume page quota
	for (let i = 0; i < 5; i += 1) {
		const infoRes = {};
		await infoHandler(
			{ uid: 50, query: { token: quotaToken }, sessionID: 'session-quota', ip: '10.0.0.50' },
			infoRes,
		);
		// Will return 500 because PDF URL isn't real, but NOT 403
		assert(infoRes._status !== 403, `info call #${i + 1}: token still valid (not quota-blocked)`);
	}

	// Now call page endpoint — token should still work (quota not consumed by info)
	const pageAfterInfoRes = {};
	await pageHandler(
		{ uid: 50, query: { token: quotaToken, page: '1' }, sessionID: 'session-quota', ip: '10.0.0.50' },
		pageAfterInfoRes,
	);
	// 500 because PDF URL isn't real, but NOT 403 (token is still valid)
	assert(pageAfterInfoRes._status !== 403, 'page request after 5 info calls: token still valid');

	// ------- Rate Limiting -------
	console.log('\nRate Limiting:');
	let hitRateLimit = false;
	for (let i = 0; i < 25; i += 1) {
		const rlRes = {};
		await tokenHandler(
			{ uid: 888, body: { pdfUrl: 'https://example.com/rl.pdf' }, sessionID: 's', ip: '1.1.1.1' },
			rlRes,
		);
		if (rlRes._status === 429) {
			hitRateLimit = true;
			assert(true, `rate limit hit after ${i + 1} requests (max 20/min)`);
			break;
		}
	}
	if (!hitRateLimit) {
		assert(false, 'rate limit should trigger within 25 requests');
	}

	// ------- Unique Tokens -------
	console.log('\nToken Uniqueness:');
	const tokens = new Set();
	for (let i = 0; i < 10; i += 1) {
		const uRes = {};
		await tokenHandler(
			{ uid: 100 + i, body: { pdfUrl: 'https://example.com/unique.pdf' }, sessionID: `s-${i}`, ip: `10.0.${i}.1` },
			uRes,
		);
		if (uRes._data && uRes._data.token) {
			tokens.add(uRes._data.token);
		}
	}
	assert(tokens.size === 10, 'all 10 generated tokens are unique');

	// ------- Summary -------
	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
	process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
	console.error('Test runner error:', err);
	process.exit(1);
});
