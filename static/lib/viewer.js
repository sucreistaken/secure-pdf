import { getDocument, GlobalWorkerOptions } from './pdf.min.mjs';

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;
console.log('[PDF-Secure][Viewer] ES module loaded, worker:', GlobalWorkerOptions.workerSrc);

// Listen for NodeBB SPA navigations (jQuery event)
$(window).on('action:ajaxify.end', function () {
	console.log('[PDF-Secure][Viewer] action:ajaxify.end fired');
	interceptPdfLinks();
});

// Also run immediately for the current page
console.log('[PDF-Secure][Viewer] Running initial interceptPdfLinks...');
interceptPdfLinks();

function interceptPdfLinks() {
	var postContents = document.querySelectorAll('[component="post/content"]');
	console.log('[PDF-Secure][Viewer] Found ' + postContents.length + ' post areas');

	postContents.forEach(function (content, idx) {
		var pdfLinks = content.querySelectorAll('a[href$=".pdf"], a[href$=".PDF"]');
		console.log('[PDF-Secure][Viewer] Post #' + idx + ': ' + pdfLinks.length + ' PDF links');

		pdfLinks.forEach(function (link) {
			if (link.dataset.pdfSecure) return;
			link.dataset.pdfSecure = 'true';

			var href = link.getAttribute('href');
			var parts = href.split('/');
			var filename = parts[parts.length - 1];
			console.log('[PDF-Secure][Viewer] Processing:', filename);

			var container = document.createElement('div');
			container.className = 'pdf-secure-inline';
			container.innerHTML =
				'<div class="pdf-secure-inline-header">' +
					'<i class="fa fa-file-pdf-o"></i> ' +
					'<span class="pdf-secure-filename">' + escapeHtml(link.textContent || filename) + '</span>' +
				'</div>' +
				'<div class="pdf-secure-inline-body">' +
					'<div class="pdf-secure-loading">Loading PDF...</div>' +
					'<div class="pdf-secure-error"></div>' +
					'<canvas class="pdf-secure-canvas"></canvas>' +
				'</div>' +
				'<div class="pdf-secure-inline-footer">' +
					'<button class="pdf-secure-prev" disabled>&#8249; Prev</button>' +
					'<span class="pdf-secure-page-info"></span>' +
					'<button class="pdf-secure-next" disabled>Next &#8250;</button>' +
				'</div>';

			link.replaceWith(container);
			console.log('[PDF-Secure][Viewer] Container created for:', filename);

			loadPdf(container, filename);
		});
	});
}

async function loadPdf(container, filename) {
	var loadingEl = container.querySelector('.pdf-secure-loading');
	var errorEl = container.querySelector('.pdf-secure-error');
	var canvas = container.querySelector('.pdf-secure-canvas');
	var footer = container.querySelector('.pdf-secure-inline-footer');
	var prevBtn = container.querySelector('.pdf-secure-prev');
	var nextBtn = container.querySelector('.pdf-secure-next');
	var pageInfo = container.querySelector('.pdf-secure-page-info');
	var bodyEl = container.querySelector('.pdf-secure-inline-body');

	function showError(msg) {
		console.error('[PDF-Secure][Viewer] ERROR ' + filename + ':', msg);
		loadingEl.style.display = 'none';
		canvas.style.display = 'none';
		errorEl.style.display = 'flex';
		errorEl.textContent = msg;
	}

	try {
		// Step 1: Fetch nonce
		var nonceUrl = config.relative_path + '/api/v3/plugins/pdf-secure/nonce?file=' + encodeURIComponent(filename);
		console.log('[PDF-Secure][Viewer] Step 1 - Nonce request:', nonceUrl);

		var nonceRes = await fetch(nonceUrl, {
			credentials: 'same-origin',
			headers: { 'x-csrf-token': config.csrf_token },
		});
		console.log('[PDF-Secure][Viewer] Step 1 - Status:', nonceRes.status);

		if (!nonceRes.ok) {
			showError(nonceRes.status === 401 ? 'Log in to view this PDF.' : 'Failed to load PDF (' + nonceRes.status + ')');
			return;
		}

		var result = await nonceRes.json();
		var nonce = result.response.nonce;
		console.log('[PDF-Secure][Viewer] Step 1 - Nonce:', nonce);

		// Step 2: Fetch PDF binary
		var pdfUrl = config.relative_path + '/api/v3/plugins/pdf-secure/pdf-data?nonce=' + encodeURIComponent(nonce);
		console.log('[PDF-Secure][Viewer] Step 2 - PDF request:', pdfUrl);

		var pdfRes = await fetch(pdfUrl, { credentials: 'same-origin' });
		console.log('[PDF-Secure][Viewer] Step 2 - Status:', pdfRes.status);

		if (!pdfRes.ok) {
			showError('Failed to load PDF data (' + pdfRes.status + ')');
			return;
		}

		var pdfArrayBuffer = await pdfRes.arrayBuffer();
		console.log('[PDF-Secure][Viewer] Step 2 - PDF loaded:', pdfArrayBuffer.byteLength, 'bytes');

		// Step 3: Render PDF
		console.log('[PDF-Secure][Viewer] Step 3 - Rendering...');
		var pdfDoc = await getDocument({ data: new Uint8Array(pdfArrayBuffer) }).promise;
		var totalPages = pdfDoc.numPages;
		console.log('[PDF-Secure][Viewer] Step 3 - Pages:', totalPages);

		loadingEl.style.display = 'none';
		canvas.style.display = 'block';

		// Security: scoped to container
		container.addEventListener('contextmenu', function (e) { e.preventDefault(); });
		container.addEventListener('dragstart', function (e) { e.preventDefault(); });
		container.addEventListener('selectstart', function (e) { e.preventDefault(); });

		var ctx = canvas.getContext('2d');
		var currentPage = 1;
		var rendering = false;

		async function renderPage(pageNum) {
			if (rendering) return;
			rendering = true;
			console.log('[PDF-Secure][Viewer] renderPage(' + pageNum + ')');

			try {
				var page = await pdfDoc.getPage(pageNum);
				var containerWidth = bodyEl.clientWidth - 20;
				var vp = page.getViewport({ scale: 1 });
				var scale = Math.min(containerWidth / vp.width, 2.0);
				var scaled = page.getViewport({ scale: scale });

				canvas.width = scaled.width;
				canvas.height = scaled.height;

				await page.render({ canvasContext: ctx, viewport: scaled }).promise;

				currentPage = pageNum;
				pageInfo.textContent = currentPage + ' / ' + totalPages;
				prevBtn.disabled = currentPage <= 1;
				nextBtn.disabled = currentPage >= totalPages;
				console.log('[PDF-Secure][Viewer] renderPage(' + pageNum + ') done, canvas:', scaled.width + 'x' + scaled.height);
			} catch (err) {
				console.error('[PDF-Secure][Viewer] Render error:', err);
				showError('Error rendering page.');
			}
			rendering = false;
		}

		await renderPage(1);

		if (totalPages > 1) {
			footer.style.display = 'flex';
			prevBtn.addEventListener('click', function () {
				if (currentPage > 1) renderPage(currentPage - 1);
			});
			nextBtn.addEventListener('click', function () {
				if (currentPage < totalPages) renderPage(currentPage + 1);
			});
			console.log('[PDF-Secure][Viewer] Navigation enabled (' + totalPages + ' pages)');
		}

		console.log('[PDF-Secure][Viewer] DONE for:', filename);
	} catch (err) {
		console.error('[PDF-Secure][Viewer] CATCH:', err);
		console.error('[PDF-Secure][Viewer] Stack:', err.stack);
		showError('Failed to load PDF.');
	}
}

function escapeHtml(str) {
	var d = document.createElement('div');
	d.textContent = str;
	return d.innerHTML;
}
