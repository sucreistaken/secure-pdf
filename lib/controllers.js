'use strict';

const nonceStore = require('./nonce-store');
const pdfHandler = require('./pdf-handler');

const Controllers = module.exports;

// Partial XOR - encrypts first 10KB and every 50th byte after that
// Now uses dynamic key from nonce data
function partialXorEncode(buffer, xorKey) {
	const data = Buffer.from(buffer);
	const keyLen = xorKey.length;

	// Encrypt first 10KB fully
	const fullEncryptLen = Math.min(10240, data.length);
	for (let i = 0; i < fullEncryptLen; i++) {
		data[i] = data[i] ^ xorKey[i % keyLen];
	}

	// Encrypt every 50th byte after that
	for (let i = fullEncryptLen; i < data.length; i += 50) {
		data[i] = data[i] ^ xorKey[i % keyLen];
	}

	return data;
}

Controllers.renderAdminPage = function (req, res) {
	res.render('admin/plugins/pdf-secure', {
		title: 'PDF Secure Viewer',
	});
};

Controllers.servePdfBinary = async function (req, res) {
	const { nonce } = req.query;
	if (!nonce) {
		return res.status(400).json({ error: 'Missing nonce' });
	}

	const uid = req.uid || 0; // Guest uid = 0

	const data = nonceStore.validate(nonce, uid);
	if (!data) {
		return res.status(403).json({ error: 'Invalid or expired nonce' });
	}

	try {
		let pdfBuffer;
		if (data.isPremium) {
			pdfBuffer = await pdfHandler.getFullPdf(data.file);
		} else {
			pdfBuffer = await pdfHandler.getSinglePagePdf(data.file);
		}

		// Apply partial XOR encryption with dynamic key from nonce
		const encodedBuffer = partialXorEncode(pdfBuffer, data.xorKey);

		res.set({
			'Content-Type': 'image/gif',  // Misleading - actual PDF binary
			'Cache-Control': 'no-store, no-cache, must-revalidate, private',
			'X-Content-Type-Options': 'nosniff',
			'Content-Disposition': 'inline',
		});

		return res.send(encodedBuffer);
	} catch (err) {
		if (err.message === 'File not found') {
			return res.status(404).json({ error: 'PDF not found' });
		}
		return res.status(500).json({ error: 'Internal error' });
	}
};
