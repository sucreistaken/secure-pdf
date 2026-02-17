'use strict';

// Main plugin logic - PDF links become inline embedded viewers with lazy loading + queue
(async function () {
	// ============================================
	// PDF.js PRELOAD - Cache CDN assets before iframe loads
	// ============================================
	(function preloadPdfJs() {
		const preloads = [
			{ href: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', as: 'script' },
			{ href: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf_viewer.min.css', as: 'style' }
		];
		preloads.forEach(({ href, as }) => {
			if (!document.querySelector(`link[href="${href}"]`)) {
				const link = document.createElement('link');
				link.rel = 'preload';
				link.href = href;
				link.as = as;
				link.crossOrigin = 'anonymous';
				document.head.appendChild(link);
			}
		});
	})();

	// Loading queue - only load one PDF at a time
	const loadQueue = [];
	let isLoading = false;
	let currentResolver = null;

	// ============================================
	// SPA MEMORY CACHE - Cache decoded PDF buffers
	// ============================================
	const pdfBufferCache = new Map();  // filename -> ArrayBuffer
	const CACHE_MAX_SIZE = 5;  // ~50MB limit (avg 10MB per PDF)
	let currentLoadingFilename = null;

	function setCachedBuffer(filename, buffer) {
		// Evict oldest if cache is full
		if (pdfBufferCache.size >= CACHE_MAX_SIZE) {
			const firstKey = pdfBufferCache.keys().next().value;
			pdfBufferCache.delete(firstKey);
			console.log('[PDF-Secure] Cache: Evicted', firstKey);
		}
		pdfBufferCache.set(filename, buffer);
		console.log('[PDF-Secure] Cache: Stored', filename, '(', (buffer.byteLength / 1024 / 1024).toFixed(2), 'MB)');
	}

	// Listen for postMessage from iframe
	window.addEventListener('message', function (event) {
		// Security: Only accept messages from same origin
		if (event.origin !== window.location.origin) return;

		// PDF ready - resolve queue
		if (event.data && event.data.type === 'pdf-secure-ready') {
			console.log('[PDF-Secure] Queue: PDF ready -', event.data.filename);
			if (currentResolver) {
				currentResolver();
				currentResolver = null;
			}
		}

		// PDF buffer from viewer - cache it
		if (event.data && event.data.type === 'pdf-secure-buffer') {
			const { filename, buffer } = event.data;
			if (filename && buffer) {
				setCachedBuffer(filename, buffer);
			}
		}

		// Viewer asking for cached buffer
		if (event.data && event.data.type === 'pdf-secure-cache-request') {
			const { filename } = event.data;
			const cached = pdfBufferCache.get(filename);
			if (cached && event.source) {
				// Send cached buffer to viewer (transferable for 0-copy)
				event.source.postMessage({
					type: 'pdf-secure-cache-response',
					filename: filename,
					buffer: cached
				}, event.origin, [cached.slice(0)]);  // Clone buffer since we keep original
				console.log('[PDF-Secure] Cache: Hit -', filename);
			} else if (event.source) {
				// No cache, viewer will fetch normally
				event.source.postMessage({
					type: 'pdf-secure-cache-response',
					filename: filename,
					buffer: null
				}, event.origin);
				console.log('[PDF-Secure] Cache: Miss -', filename);
			}
		}
	});

	async function processQueue() {
		if (isLoading || loadQueue.length === 0) return;

		isLoading = true;
		const { wrapper, filename, placeholder } = loadQueue.shift();

		try {
			await loadPdfIframe(wrapper, filename, placeholder);
		} catch (err) {
			console.error('[PDF-Secure] Load error:', err);
		}

		isLoading = false;

		// Small delay between loads
		setTimeout(processQueue, 200);
	}

	function queuePdfLoad(wrapper, filename, placeholder) {
		loadQueue.push({ wrapper, filename, placeholder });
		processQueue();
	}

	try {
		var hooks = await app.require('hooks');

		hooks.on('action:ajaxify.end', function () {
			// Clear queue on page change
			loadQueue.length = 0;
			isLoading = false;
			currentResolver = null;
			interceptPdfLinks();
		});
	} catch (err) {
		console.error('[PDF-Secure] Init error:', err);
	}

	function interceptPdfLinks() {
		var postContents = document.querySelectorAll('[component="post/content"]');

		postContents.forEach(function (content) {
			// NEW: Detect server-rendered secure placeholders (hides URL from source)
			var placeholders = content.querySelectorAll('.pdf-secure-placeholder');
			placeholders.forEach(function (placeholder) {
				if (placeholder.dataset.pdfSecureProcessed) return;
				placeholder.dataset.pdfSecureProcessed = 'true';

				var filename = placeholder.dataset.filename;
				var displayName = placeholder.querySelector('span')?.textContent || filename;

				createPdfViewer(placeholder, filename, displayName);
			});

			// FALLBACK: Detect old-style PDF links (for backwards compatibility)
			var pdfLinks = content.querySelectorAll('a[href$=".pdf"], a[href$=".PDF"]');
			pdfLinks.forEach(function (link) {
				if (link.dataset.pdfSecure) return;
				link.dataset.pdfSecure = 'true';

				var href = link.getAttribute('href');
				var parts = href.split('/');
				var filename = parts[parts.length - 1];
				var displayName = link.textContent || filename;

				createPdfViewer(link, filename, displayName);
			});
		});
	}

	function createPdfViewer(targetElement, filename, displayName) {

		// Create container
		var container = document.createElement('div');
		container.className = 'pdf-secure-embed';
		container.style.cssText = 'margin:16px 0;border-radius:12px;overflow:hidden;background:#1f1f1f;border:1px solid rgba(255,255,255,0.1);box-shadow:0 4px 20px rgba(0,0,0,0.25);';

		// Header
		var header = document.createElement('div');
		header.className = 'pdf-secure-embed-header';
		header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:linear-gradient(135deg,#2d2d2d 0%,#252525 100%);border-bottom:1px solid rgba(255,255,255,0.08);';

		var title = document.createElement('div');
		title.className = 'pdf-secure-embed-title';
		title.style.cssText = 'display:flex;align-items:center;gap:10px;color:#fff;font-size:14px;font-weight:500;';

		var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		icon.setAttribute('viewBox', '0 0 24 24');
		icon.style.cssText = 'width:20px;height:20px;min-width:20px;max-width:20px;fill:#e81224;flex-shrink:0;';
		icon.innerHTML = '<path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/>';

		var nameSpan = document.createElement('span');
		nameSpan.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:400px;';
		try { nameSpan.textContent = decodeURIComponent(displayName); }
		catch (e) { nameSpan.textContent = displayName; }

		title.appendChild(icon);
		title.appendChild(nameSpan);

		header.appendChild(title);
		container.appendChild(header);

		// Body with loading placeholder
		var iframeWrapper = document.createElement('div');
		iframeWrapper.className = 'pdf-secure-embed-body';
		iframeWrapper.style.cssText = 'position:relative;width:100%;height:600px;background:#525659;';

		// Loading placeholder - ALWAYS VISIBLE until PDF ready (z-index: 10)
		var loadingPlaceholder = document.createElement('div');
		loadingPlaceholder.className = 'pdf-loading-placeholder';
		loadingPlaceholder.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#2d2d2d;color:#fff;gap:16px;z-index:10;transition:opacity 0.3s;';
		loadingPlaceholder.innerHTML = `
					<svg viewBox="0 0 24 24" style="width:48px;height:48px;fill:#555;">
						<path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/>
					</svg>
					<div class="pdf-loading-text" style="font-size:14px;color:#a0a0a0;">Sırada bekliyor...</div>
					<style>@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}</style>
				`;
		iframeWrapper.appendChild(loadingPlaceholder);

		container.appendChild(iframeWrapper);

		targetElement.replaceWith(container);

		// LAZY LOADING with Intersection Observer + Queue
		// Smart loading: only loads PDFs that are actually visible
		var queueEntry = null;  // Track if this PDF is in queue
		var observer = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (entry.isIntersecting) {
					// Update placeholder to show loading state
					var textEl = loadingPlaceholder.querySelector('.pdf-loading-text');
					if (textEl) textEl.textContent = 'PDF Yükleniyor...';

					var svgEl = loadingPlaceholder.querySelector('svg');
					if (svgEl) {
						svgEl.style.fill = '#0078d4';
						svgEl.style.animation = 'spin 1s linear infinite';
						svgEl.innerHTML = '<path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"/>';
					}

					// Add to queue (if not already)
					if (!queueEntry) {
						queueEntry = { wrapper: iframeWrapper, filename, placeholder: loadingPlaceholder };
						loadQueue.push(queueEntry);
						processQueue();
					}
				} else {
					// LEFT viewport - remove from queue if waiting
					if (queueEntry && loadQueue.includes(queueEntry)) {
						var idx = loadQueue.indexOf(queueEntry);
						if (idx > -1) {
							loadQueue.splice(idx, 1);
							console.log('[PDF-Secure] Queue: Removed (left viewport) -', filename);

							// Reset placeholder to waiting state
							var textEl = loadingPlaceholder.querySelector('.pdf-loading-text');
							if (textEl) textEl.textContent = 'Sırada bekliyor...';
							var svgEl = loadingPlaceholder.querySelector('svg');
							if (svgEl) {
								svgEl.style.fill = '#555';
								svgEl.style.animation = 'none';
								svgEl.innerHTML = '<path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/>';
							}
						}
						queueEntry = null;
					}
				}
			});
		}, {
			rootMargin: '0px',  // Only trigger when actually visible
			threshold: 0
		});

		observer.observe(container);
	}

	function loadPdfIframe(wrapper, filename, placeholder) {
		return new Promise((resolve, reject) => {
			// Create iframe HIDDEN (z-index: 1, under placeholder)
			var iframe = document.createElement('iframe');
			iframe.className = 'pdf-secure-iframe';
			iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;z-index:1;';
			iframe.src = config.relative_path + '/plugins/pdf-secure/viewer?file=' + encodeURIComponent(filename);
			iframe.setAttribute('frameborder', '0');
			iframe.setAttribute('allowfullscreen', 'true');

			// Store resolver for postMessage callback
			currentResolver = function () {
				// Fade out placeholder, show iframe
				if (placeholder) {
					placeholder.style.opacity = '0';
					setTimeout(function () {
						if (placeholder.parentNode) {
							placeholder.remove();
						}
					}, 300);
				}
				resolve();
			};

			iframe.onerror = function () {
				currentResolver = null;
				if (placeholder) {
					var textEl = placeholder.querySelector('.pdf-loading-text');
					if (textEl) textEl.textContent = 'Yükleme hatası!';
				}
				reject(new Error('Failed to load iframe'));
			};

			wrapper.appendChild(iframe);

			// Timeout fallback (60 seconds for large PDFs)
			setTimeout(function () {
				if (currentResolver) {
					console.log('[PDF-Secure] Queue: Timeout, forcing next');
					currentResolver();
					currentResolver = null;
				}
			}, 60000);
		});
	}
})();
