'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const store = new Map();
const NONCE_TTL = 30 * 1000; // 30 seconds
const CLEANUP_INTERVAL = 60 * 1000; // 60 seconds

// Periodic cleanup of expired nonces
setInterval(() => {
	const now = Date.now();
	for (const [nonce, data] of store.entries()) {
		if (now - data.createdAt > NONCE_TTL) {
			store.delete(nonce);
		}
	}
}, CLEANUP_INTERVAL).unref();

// Generate a random XOR key (8 bytes)
function generateXorKey() {
	return crypto.randomBytes(8);
}

const NonceStore = module.exports;

NonceStore.generate = function (uid, file, isPremium) {
	const nonce = uuidv4();
	const xorKey = generateXorKey();

	store.set(nonce, {
		uid: uid,
		file: file,
		isPremium: isPremium,
		xorKey: xorKey,  // Store unique key for this nonce
		createdAt: Date.now(),
	});

	return {
		nonce: nonce,
		xorKey: xorKey.toString('base64')  // Return key for viewer injection
	};
};

// Get key without consuming nonce (for viewer injection)
NonceStore.getKey = function (nonce) {
	const data = store.get(nonce);
	if (!data) {
		return null;
	}
	return data.xorKey.toString('base64');
};

NonceStore.validate = function (nonce, uid) {
	const data = store.get(nonce);
	if (!data) {
		return null;
	}

	// Delete immediately (single-use)
	store.delete(nonce);

	// Check UID match
	if (data.uid !== uid) {
		return null;
	}

	// Check TTL
	if (Date.now() - data.createdAt > NONCE_TTL) {
		return null;
	}

	return data;  // Now includes xorKey
};
