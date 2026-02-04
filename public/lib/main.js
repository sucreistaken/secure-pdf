'use strict';

/**
 * Secure PDF Viewer - Main Entry Point
 * Automatically detects and converts PDF links to secure viewers
 * PDF URLs never exposed to client - only server tokens are used
 *
 * This file is listed under "scripts" in plugin.json — it runs on every page.
 * Do NOT wrap in define() — that would make it a page module instead.
 */

$(document).ready(function () {
	console.log('[SecurePDF] main.js yuklendi');
	initSecurePdfViewer();
});

$(window).on('action:ajaxify.end', function () {
	initSecurePdfViewer();
});

$(window).on('action:topic.loaded action:posts.loaded', function () {
	initSecurePdfViewer();
});

function initSecurePdfViewer() {
	// Find all unprocessed PDF links
	var pdfLinks = document.querySelectorAll('a[href$=".pdf"]:not(.spdf-processed), a[href*=".pdf?"]:not(.spdf-processed)');

	if (pdfLinks.length === 0) {
		return;
	}

	console.log('[SecurePDF] PDF link sayisi:', pdfLinks.length);

	pdfLinks.forEach(function (link, index) {
		console.log('[SecurePDF] PDF link [' + index + ']:', link.href);

		// Mark as processed
		link.classList.add('spdf-processed');

		var pdfUrl = link.href;
		var containerId = 'spdf-' + Math.random().toString(36).substr(2, 9);

		// Hide original link
		link.style.display = 'none';

		// Create viewer container (no PDF URL in DOM)
		var container = document.createElement('div');
		container.id = containerId;
		container.className = 'spdf-viewer-wrapper';
		link.parentNode.insertBefore(container, link.nextSibling);

		// Request token from server (PDF URL sent only in POST body, never in DOM)
		requestTokenAndLoad(pdfUrl, containerId);
	});
}

function requestTokenAndLoad(pdfUrl, containerId) {
	var container = document.getElementById(containerId);
	if (!container) {
		return;
	}

	// Show loading state
	container.innerHTML = '<div class="spdf-loading"><div class="spdf-loading-spinner"></div><span>Loading...</span></div>';

	var tokenUrl = config.relative_path + '/api/secure-pdf/token';

	fetch(tokenUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-csrf-token': config.csrf_token,
		},
		body: JSON.stringify({ pdfUrl: pdfUrl }),
	})
		.then(function (response) {
			return response.json();
		})
		.then(function (data) {
			if (!data || !data.response || !data.response.token) {
				throw new Error('Token alinamadi: ' + JSON.stringify(data));
			}

			var token = data.response.token;
			var hasFullAccess = data.response.hasFullAccess;
			var freePageLimit = data.response.freePageLimit;

			var isMobile = window.innerWidth <= 768;

			if (isMobile) {
				container.innerHTML =
					'<div class="spdf-mobile-trigger">' +
					'<button class="spdf-mobile-btn">' +
					'<span class="spdf-mobile-icon">\uD83D\uDCC4</span>' +
					'<span class="spdf-mobile-text">PDF\'i G\u00F6r\u00FCnt\u00FCle</span>' +
					'</button>' +
					'</div>';

				container.querySelector('.spdf-mobile-btn').addEventListener('click', function () {
					openMobileViewer(token, hasFullAccess, freePageLimit);
				});
			} else {
				require(['secure-pdf/viewer'], function (Viewer) {
					var viewer = Viewer.init('#' + containerId, {
						token: token,
						hasFullAccess: hasFullAccess,
						freePageLimit: freePageLimit,
					});
					if (viewer) {
						viewer.loadFromServer(token);
					}
				});
			}
		})
		.catch(function (err) {
			console.error('[SecurePDF] HATA:', err.message);
			container.innerHTML = '<div class="spdf-error"><div class="spdf-error-icon">\u26A0\uFE0F</div><div class="spdf-error-text">PDF y\u00FCklenemedi</div></div>';
		});
}

function openMobileViewer(token, hasFullAccess, freePageLimit) {
	var modal = document.createElement('div');
	modal.className = 'spdf-mobile-modal';
	modal.innerHTML =
		'<div class="spdf-mobile-header">' +
		'<button class="spdf-mobile-close">\u2715</button>' +
		'<span>PDF Viewer</span>' +
		'</div>' +
		'<div class="spdf-mobile-content" id="spdf-mobile-viewer"></div>';

	document.body.appendChild(modal);
	document.body.style.overflow = 'hidden';

	modal.querySelector('.spdf-mobile-close').addEventListener('click', function () {
		modal.remove();
		document.body.style.overflow = '';
	});

	require(['secure-pdf/viewer'], function (Viewer) {
		var viewer = Viewer.init('#spdf-mobile-viewer', {
			token: token,
			hasFullAccess: hasFullAccess,
			freePageLimit: freePageLimit,
		});
		if (viewer) {
			viewer.loadFromServer(token);
		}
	});
}
