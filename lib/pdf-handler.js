'use strict';

const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const nconf = require.main.require('nconf');

const singlePageCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Periodic cleanup of expired cache entries
setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of singlePageCache.entries()) {
		if (now - entry.createdAt > CACHE_TTL) {
			singlePageCache.delete(key);
		}
	}
}, 10 * 60 * 1000).unref(); // cleanup every 10 minutes

const PdfHandler = module.exports;

PdfHandler.resolveFilePath = function (filename) {
	// Sanitize: only allow basename (prevent directory traversal)
	const safeName = path.basename(filename);
	if (!safeName || safeName !== filename || safeName.includes('..')) {
		return null;
	}

	const uploadPath = nconf.get('upload_path') || path.join(nconf.get('base_dir'), 'public', 'uploads');
	const filePath = path.join(uploadPath, 'files', safeName);

	// Verify the resolved path is still within the upload directory
	const resolvedPath = path.resolve(filePath);
	const resolvedUploadDir = path.resolve(path.join(uploadPath, 'files'));
	if (!resolvedPath.startsWith(resolvedUploadDir)) {
		return null;
	}

	return filePath;
};

PdfHandler.getFullPdf = async function (filename) {
	const filePath = PdfHandler.resolveFilePath(filename);
	if (!filePath) {
		throw new Error('Invalid filename');
	}

	if (!fs.existsSync(filePath)) {
		throw new Error('File not found');
	}

	return fs.promises.readFile(filePath);
};

PdfHandler.getSinglePagePdf = async function (filename) {
	// Check cache first
	const cached = singlePageCache.get(filename);
	if (cached && (Date.now() - cached.createdAt < CACHE_TTL)) {
		return cached.buffer;
	}

	const filePath = PdfHandler.resolveFilePath(filename);
	if (!filePath) {
		throw new Error('Invalid filename');
	}

	if (!fs.existsSync(filePath)) {
		throw new Error('File not found');
	}

	const existingPdfBytes = await fs.promises.readFile(filePath);
	const srcDoc = await PDFDocument.load(existingPdfBytes);

	const newDoc = await PDFDocument.create();
	const [copiedPage] = await newDoc.copyPages(srcDoc, [0]);
	newDoc.addPage(copiedPage);

	const pdfBytes = await newDoc.save();
	const buffer = Buffer.from(pdfBytes);

	// Cache the result
	singlePageCache.set(filename, {
		buffer: buffer,
		createdAt: Date.now(),
	});

	return buffer;
};
