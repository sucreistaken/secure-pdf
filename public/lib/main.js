'use strict';

/**
 * Secure PDF Viewer - Main Entry Point
 * Automatically detects and converts PDF links to secure viewers
 */

$(document).ready(function () {
	initSecurePdfViewer();
});

$(window).on('action:topic.loaded action:posts.loaded', function () {
	initSecurePdfViewer();
});

function initSecurePdfViewer() {
	// Find all unprocessed PDF links
	const pdfLinks = document.querySelectorAll('a[href$=".pdf"]:not(.spdf-processed), a[href*=".pdf?"]:not(.spdf-processed)');

	pdfLinks.forEach(function (link) {
		// Mark as processed
		link.classList.add('spdf-processed');

		const pdfUrl = link.href;
		const containerId = 'spdf-' + Math.random().toString(36).substr(2, 9);

		// Hide original link
		link.style.display = 'none';

		// Create viewer container
		const container = document.createElement('div');
		container.id = containerId;
		container.className = 'spdf-viewer-wrapper';
		link.parentNode.insertBefore(container, link.nextSibling);

		// Check if mobile
		const isMobile = window.innerWidth <= 768;

		if (isMobile) {
			// Mobile: Show button to open in fullscreen
			container.innerHTML = `
                <div class="spdf-mobile-trigger">
                    <button class="spdf-mobile-btn" data-url="${pdfUrl}">
                        <span class="spdf-mobile-icon">📄</span>
                        <span class="spdf-mobile-text">PDF'i Görüntüle</span>
                    </button>
                </div>
            `;

			container.querySelector('.spdf-mobile-btn').addEventListener('click', function () {
				openMobileViewer(pdfUrl);
			});
		} else {
			// Desktop: Embedded viewer
			require(['secure-pdf/viewer'], function (Viewer) {
				Viewer.init('#' + containerId, {
					pdfUrl: pdfUrl
				});
				Viewer.loadPDF(pdfUrl);
			});
		}
	});
}

function openMobileViewer(pdfUrl) {
	// Open fullscreen modal on mobile
	const modal = document.createElement('div');
	modal.className = 'spdf-mobile-modal';
	modal.innerHTML = `
        <div class="spdf-mobile-header">
            <button class="spdf-mobile-close">✕</button>
            <span>PDF Viewer</span>
        </div>
        <div class="spdf-mobile-content" id="spdf-mobile-viewer"></div>
    `;

	document.body.appendChild(modal);
	document.body.style.overflow = 'hidden';

	modal.querySelector('.spdf-mobile-close').addEventListener('click', function () {
		modal.remove();
		document.body.style.overflow = '';
	});

	require(['secure-pdf/viewer'], function (Viewer) {
		Viewer.init('#spdf-mobile-viewer', {
			pdfUrl: pdfUrl
		});
		Viewer.loadPDF(pdfUrl);
	});
}
