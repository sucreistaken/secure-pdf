'use strict';

/**
 * Secure PDF Viewer — Full Annotation Tools
 * Instance-based: supports multiple viewers on the same page
 * Tools: Highlighter, Pen, Eraser, Select/Move, Text, Shapes
 * Features: Thumbnails, Sepia, Rotation, Context Menu, Keyboard Shortcuts
 */

define('secure-pdf/viewer', [], function () {
	var Viewer = {};
	var consoleProtectionInitialized = false;
	var keydownListenerAdded = false;

	// SVG icon paths (inline, no external dependency)
	var ICONS = {
		sidebar: 'M3 4h18v2H3V4zm0 7h18v2H3v-2zm0 7h18v2H3v-2z',
		highlight: 'M3 21h18v-2H3v2zM5 16h14l-3-10H8l-3 10zM9 8h6l1.5 5h-9L9 8z',
		pen: 'M20.71 4.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83zM3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z',
		eraser: 'M16.24 3.56l4.95 4.94c.78.79.78 2.05 0 2.84L12 20.53a4.008 4.008 0 01-5.66 0L2.81 17c-.78-.79-.78-2.05 0-2.84l10.6-10.6c.79-.78 2.05-.78 2.83 0zM4.22 15.58l3.54 3.53c.78.79 2.04.79 2.83 0l3.53-3.53-4.95-4.95-4.95 4.95z',
		select: 'M7 2l12 11.2-5.8.5 3.3 7.3-2.2 1-3.2-7.4L7 18.5V2z',
		text: 'M5 4v3h5.5v12h3V7H19V4H5z',
		shapes: 'M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm13 0a5 5 0 110 10 5 5 0 010-10z',
		zoomIn: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
		zoomOut: 'M19 13H5v-2h14v2z',
		rotateLeft: 'M7.11 8.53L5.7 7.11C4.8 8.27 4.24 9.61 4.07 11h2.02c.14-.87.49-1.72 1.02-2.47zM6.09 13H4.07c.17 1.39.72 2.73 1.62 3.89l1.41-1.42c-.52-.75-.87-1.59-1.01-2.47zm1.01 5.32c1.16.9 2.51 1.44 3.9 1.61V17.9c-.87-.15-1.71-.49-2.46-1.03L7.1 18.32zM13 4.07V1L8.45 5.55 13 10V6.09c2.84.48 5 2.94 5 5.91s-2.16 5.43-5 5.91v2.02c3.95-.49 7-3.85 7-7.93s-3.05-7.44-7-7.93z',
		rotateRight: 'M15.55 5.55L11 1v3.07C7.06 4.56 4 7.92 4 12s3.05 7.44 7 7.93v-2.02c-2.84-.48-5-2.94-5-5.91s2.16-5.43 5-5.91V10l4.55-4.45zM19.93 11c-.17-1.39-.72-2.73-1.62-3.89l-1.42 1.42c.54.75.88 1.6 1.02 2.47h2.02zM13 17.9v2.02c1.39-.17 2.74-.71 3.9-1.61l-1.44-1.44c-.75.54-1.59.89-2.46 1.03zm3.89-2.42l1.42 1.41c.9-1.16 1.45-2.5 1.62-3.89h-2.02c-.14.87-.48 1.72-1.02 2.48z',
		sepia: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
		arrowDown: 'M7 10l5 5 5-5z',
		copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
		duplicate: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z',
		trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
	};

	function svgIcon(name) {
		return '<svg viewBox="0 0 24 24"><path d="' + ICONS[name] + '"/></svg>';
	}

	// ==========================================
	// PUBLIC API
	// ==========================================

	Viewer.init = function (containerSelector, options) {
		var containerEl = document.querySelector(containerSelector);
		if (!containerEl) return null;

		var inst = {
			container: containerEl,
			token: options.token || null,
			options: options || {},
			totalPages: 0,
			loadedPages: {},
			pageDimensions: {},
			observer: null,
			zoomLevel: 900,
			// Annotation state
			currentTool: null,
			currentColor: '#e81224',
			currentWidth: 2,
			isDrawing: false,
			currentPath: null,
			currentDrawingPage: null,
			currentSvg: null,
			annotationsStore: new Map(),
			pageRotations: new Map(),
			sepiaMode: false,
			// Tool settings
			highlightColor: '#fff100',
			highlightWidth: 4,
			drawColor: '#e81224',
			drawWidth: 2,
			shapeColor: '#e81224',
			shapeWidth: 2,
			currentShape: 'rectangle',
			// Select
			selectedAnnotation: null,
			selectedSvg: null,
			selectedPageNum: null,
			copiedAnnotation: null,
			isDraggingAnnotation: false,
			dragStartX: 0,
			dragStartY: 0,
			// Text
			textFontSize: 14,
		};

		renderUI(inst);
		initToolbar(inst);
		initAntiDownloadProtections(inst);

		if (!consoleProtectionInitialized) {
			initConsoleProtection();
			consoleProtectionInitialized = true;
		}

		inst.loadFromServer = function (token) {
			inst.token = token;
			fetchPdfInfo(inst);
		};

		return inst;
	};

	// ==========================================
	// UI RENDERING
	// ==========================================

	function renderUI(inst) {
		var c = inst.container;
		c.style.display = 'flex';
		c.style.flexDirection = 'column';
		c.style.height = '100vh';
		c.style.overflow = 'hidden';
		c.style.position = 'relative';

		// Highlight color dots
		var hlColors = ['#fff100', '#16c60c', '#00b7c3', '#0078d4', '#886ce4', '#e81224'];
		var hlDotsHtml = hlColors.map(function (cl) {
			return '<div class="spdf-color-dot' + (cl === '#fff100' ? ' active' : '') + '" style="background:' + cl + '" data-color="' + cl + '"></div>';
		}).join('');

		// Pen color dots (24 colors)
		var penColors = ['#000000', '#ffffff', '#808080', '#c0c0c0', '#404040', '#f5f5dc', '#ff6b9d', '#e81224', '#ff8c00', '#fff100', '#ffd700', '#f5deb3', '#16c60c', '#00ff00', '#008b8b', '#0078d4', '#00bfff', '#add8e6', '#9400d3', '#886ce4', '#dda0dd', '#ffdab9', '#d2691e', '#8b4513'];
		var penDotsHtml = penColors.map(function (cl) {
			return '<div class="spdf-color-dot' + (cl === '#e81224' ? ' active' : '') + '" style="background:' + cl + '" data-color="' + cl + '"></div>';
		}).join('');

		// Shape color dots
		var shapeColors = ['#e81224', '#0078d4', '#16c60c', '#fff100', '#000000', '#ffffff'];
		var shapeDotsHtml = shapeColors.map(function (cl) {
			return '<div class="spdf-color-dot' + (cl === '#e81224' ? ' active' : '') + '" style="background:' + cl + '" data-color="' + cl + '"></div>';
		}).join('');

		c.innerHTML =
			// Toolbar
			'<div class="spdf-toolbar">' +
				'<div class="spdf-toolbar-group">' +
					'<button class="spdf-toolbar-btn spdf-btn-sidebar" data-tooltip="Icindekiler (S)">' + svgIcon('sidebar') + '</button>' +
				'</div>' +
				'<div class="spdf-separator"></div>' +
				'<div class="spdf-toolbar-group">' +
					// Highlighter
					'<div class="spdf-btn-with-dropdown spdf-highlight-wrap">' +
						'<button class="spdf-toolbar-btn spdf-btn-highlight" data-tooltip="Vurgula (H)">' + svgIcon('highlight') + '</button>' +
						'<button class="spdf-dropdown-arrow spdf-highlight-arrow">' + svgIcon('arrowDown') + '</button>' +
						'<div class="spdf-dropdown spdf-highlight-dropdown">' +
							'<div class="spdf-dropdown-section"><div class="spdf-dropdown-label">Renkler</div><div class="spdf-color-grid spdf-highlight-colors">' + hlDotsHtml + '</div></div>' +
							'<div class="spdf-stroke-preview"><svg viewBox="0 0 200 50" preserveAspectRatio="none"><path class="spdf-hl-wave" d="M10,35 Q50,10 100,25 T190,25" fill="none" stroke="#fff100" stroke-width="10" stroke-linecap="round" stroke-opacity="0.5"/></svg></div>' +
							'<div class="spdf-dropdown-section"><div class="spdf-dropdown-label">Kalinlik</div><div class="spdf-thickness-slider"><input type="range" class="spdf-hl-thickness" min="1" max="10" value="4"><div class="spdf-thickness-labels"><span>Ince</span><span>Kalin</span></div></div></div>' +
						'</div>' +
					'</div>' +
					// Pen
					'<div class="spdf-btn-with-dropdown spdf-draw-wrap">' +
						'<button class="spdf-toolbar-btn spdf-btn-draw" data-tooltip="Kalem (P)">' + svgIcon('pen') + '</button>' +
						'<button class="spdf-dropdown-arrow spdf-draw-arrow">' + svgIcon('arrowDown') + '</button>' +
						'<div class="spdf-dropdown spdf-draw-dropdown">' +
							'<div class="spdf-dropdown-section"><div class="spdf-dropdown-label">Renkler</div><div class="spdf-color-grid spdf-draw-colors">' + penDotsHtml + '</div></div>' +
							'<div class="spdf-stroke-preview"><svg viewBox="0 0 200 50" preserveAspectRatio="none"><path class="spdf-draw-wave" d="M10,35 Q50,10 100,25 T190,25" fill="none" stroke="#e81224" stroke-width="3" stroke-linecap="round"/></svg></div>' +
							'<div class="spdf-dropdown-section"><div class="spdf-dropdown-label">Kalinlik</div><div class="spdf-thickness-slider"><input type="range" class="spdf-draw-thickness" min="1" max="10" value="2"><div class="spdf-thickness-labels"><span>Ince</span><span>Kalin</span></div></div></div>' +
						'</div>' +
					'</div>' +
					// Eraser, Select, Text
					'<button class="spdf-toolbar-btn spdf-btn-eraser" data-tooltip="Silgi (E)">' + svgIcon('eraser') + '</button>' +
					'<button class="spdf-toolbar-btn spdf-btn-select" data-tooltip="Sec/Tasi (V)">' + svgIcon('select') + '</button>' +
					'<button class="spdf-toolbar-btn spdf-btn-text" data-tooltip="Metin (T)">' + svgIcon('text') + '</button>' +
					// Shapes
					'<div class="spdf-btn-with-dropdown spdf-shapes-wrap">' +
						'<button class="spdf-toolbar-btn spdf-btn-shapes" data-tooltip="Sekiller (R)">' + svgIcon('shapes') + '</button>' +
						'<button class="spdf-dropdown-arrow spdf-shapes-arrow">' + svgIcon('arrowDown') + '</button>' +
						'<div class="spdf-dropdown spdf-shapes-dropdown">' +
							'<div class="spdf-dropdown-section"><div class="spdf-dropdown-label">Sekil</div><div class="spdf-shape-grid">' +
								'<button class="spdf-shape-btn active" data-shape="rectangle"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>' +
								'<button class="spdf-shape-btn" data-shape="circle"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>' +
								'<button class="spdf-shape-btn" data-shape="line"><svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="4" stroke="currentColor" stroke-width="2"/></svg></button>' +
								'<button class="spdf-shape-btn" data-shape="arrow"><svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="4" stroke="currentColor" stroke-width="2"/><polyline points="10,4 20,4 20,14" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>' +
							'</div></div>' +
							'<div class="spdf-dropdown-section"><div class="spdf-dropdown-label">Renkler</div><div class="spdf-color-grid spdf-shape-colors">' + shapeDotsHtml + '</div></div>' +
							'<div class="spdf-dropdown-section"><div class="spdf-dropdown-label">Kalinlik</div><div class="spdf-thickness-slider"><input type="range" class="spdf-shape-thickness" min="1" max="10" value="2"><div class="spdf-thickness-labels"><span>Ince</span><span>Kalin</span></div></div></div>' +
						'</div>' +
					'</div>' +
				'</div>' +
				'<div class="spdf-separator"></div>' +
				'<div class="spdf-toolbar-group">' +
					'<button class="spdf-toolbar-btn spdf-btn-zoomout" data-tooltip="Uzaklastir">' + svgIcon('zoomOut') + '</button>' +
					'<button class="spdf-toolbar-btn spdf-btn-zoomin" data-tooltip="Yakinlastir">' + svgIcon('zoomIn') + '</button>' +
					'<div class="spdf-separator"></div>' +
					'<button class="spdf-toolbar-btn spdf-btn-rotleft" data-tooltip="Sola Dondur">' + svgIcon('rotateLeft') + '</button>' +
					'<button class="spdf-toolbar-btn spdf-btn-rotright" data-tooltip="Saga Dondur">' + svgIcon('rotateRight') + '</button>' +
					'<div class="spdf-separator"></div>' +
					'<button class="spdf-toolbar-btn spdf-btn-sepia" data-tooltip="Okuma Modu (M)">' + svgIcon('sepia') + '</button>' +
				'</div>' +
				'<div class="spdf-page-info-group">' +
					'<input type="number" class="spdf-page-input" value="1" min="1">' +
					'<span class="spdf-page-count">/ --</span>' +
				'</div>' +
			'</div>' +
			// Viewer main
			'<div class="spdf-viewer-main">' +
				// Thumbnail sidebar
				'<div class="spdf-thumbnail-sidebar">' +
					'<div class="spdf-sidebar-header"><span>Icindekiler</span><button class="spdf-sidebar-close">&times;</button></div>' +
					'<div class="spdf-thumbnail-container"></div>' +
				'</div>' +
				// Status bar
				'<div class="spdf-status-bar"><span class="spdf-status-text">Yukleniyor...</span></div>' +
				// Scroll container
				'<div class="spdf-scroll-container"><div class="spdf-pages-container"><div class="spdf-loading"><div class="spdf-spinner"></div><span>PDF bilgisi aliniyor...</span></div></div></div>' +
			'</div>' +
			// Context menu
			'<div class="spdf-context-menu">' +
				'<div class="spdf-context-menu-item" data-action="highlight">' + svgIcon('highlight') + ' Vurgula <span class="spdf-shortcut-hint">H</span></div>' +
				'<div class="spdf-context-menu-item" data-action="pen">' + svgIcon('pen') + ' Kalem <span class="spdf-shortcut-hint">P</span></div>' +
				'<div class="spdf-context-menu-item" data-action="text">' + svgIcon('text') + ' Metin <span class="spdf-shortcut-hint">T</span></div>' +
				'<div class="spdf-context-menu-divider"></div>' +
				'<div class="spdf-context-menu-item" data-action="zoomIn">' + svgIcon('zoomIn') + ' Yakinlastir</div>' +
				'<div class="spdf-context-menu-item" data-action="zoomOut">' + svgIcon('zoomOut') + ' Uzaklastir</div>' +
				'<div class="spdf-context-menu-divider"></div>' +
				'<div class="spdf-context-menu-item" data-action="sepia">' + svgIcon('sepia') + ' Okuma Modu <span class="spdf-shortcut-hint">M</span></div>' +
			'</div>' +
			// Selection toolbar
			'<div class="spdf-selection-toolbar">' +
				'<button data-action="copy">' + svgIcon('copy') + ' Kopyala</button>' +
				'<button data-action="duplicate">' + svgIcon('duplicate') + ' Cogalt</button>' +
				'<button data-action="delete" class="delete">' + svgIcon('trash') + ' Sil</button>' +
			'</div>';
	}

	// ==========================================
	// TOOLBAR INIT
	// ==========================================

	function initToolbar(inst) {
		var c = inst.container;

		// Tool buttons
		q(c, '.spdf-btn-highlight').onclick = function () { setTool(inst, 'highlight'); };
		q(c, '.spdf-btn-draw').onclick = function () { setTool(inst, 'pen'); };
		q(c, '.spdf-btn-eraser').onclick = function () { setTool(inst, 'eraser'); };
		q(c, '.spdf-btn-select').onclick = function () { setTool(inst, 'select'); };
		q(c, '.spdf-btn-text').onclick = function () { setTool(inst, 'text'); };
		q(c, '.spdf-btn-shapes').onclick = function () { setTool(inst, 'shape'); };

		// Zoom
		q(c, '.spdf-btn-zoomin').onclick = function () { inst.zoomLevel = Math.min(inst.zoomLevel + 100, 1600); applyZoom(inst); };
		q(c, '.spdf-btn-zoomout').onclick = function () { inst.zoomLevel = Math.max(inst.zoomLevel - 100, 300); applyZoom(inst); };

		// Rotation
		q(c, '.spdf-btn-rotleft').onclick = function () { rotatePage(inst, -90); };
		q(c, '.spdf-btn-rotright').onclick = function () { rotatePage(inst, 90); };

		// Sepia
		q(c, '.spdf-btn-sepia').onclick = function () { toggleSepia(inst); };

		// Sidebar
		q(c, '.spdf-btn-sidebar').onclick = function () { toggleSidebar(inst); };
		q(c, '.spdf-sidebar-close').onclick = function () {
			q(c, '.spdf-thumbnail-sidebar').classList.remove('open');
			q(c, '.spdf-scroll-container').classList.remove('with-sidebar');
			q(c, '.spdf-btn-sidebar').classList.remove('active');
		};

		// Page input
		q(c, '.spdf-page-input').onchange = function (e) {
			var num = parseInt(e.target.value);
			if (num >= 1 && num <= inst.totalPages) scrollToPage(inst, num);
		};

		// Dropdown arrows
		q(c, '.spdf-highlight-arrow').onclick = function (e) { toggleDd(inst, q(c, '.spdf-highlight-dropdown'), e); };
		q(c, '.spdf-draw-arrow').onclick = function (e) { toggleDd(inst, q(c, '.spdf-draw-dropdown'), e); };
		q(c, '.spdf-shapes-arrow').onclick = function (e) { toggleDd(inst, q(c, '.spdf-shapes-dropdown'), e); };

		// Close dropdowns on outside click
		document.addEventListener('click', function (e) {
			if (!e.target.closest('.spdf-dropdown') && !e.target.closest('.spdf-dropdown-arrow')) closeAllDd(inst);
		});

		// Color pickers
		setupColors(inst, '.spdf-highlight-colors', function (cl) {
			inst.highlightColor = cl; if (inst.currentTool === 'highlight') inst.currentColor = cl;
			q(c, '.spdf-hl-wave').setAttribute('stroke', cl);
		});
		setupColors(inst, '.spdf-draw-colors', function (cl) {
			inst.drawColor = cl; if (inst.currentTool === 'pen') inst.currentColor = cl;
			q(c, '.spdf-draw-wave').setAttribute('stroke', cl);
		});
		setupColors(inst, '.spdf-shape-colors', function (cl) {
			inst.shapeColor = cl; if (inst.currentTool === 'shape') inst.currentColor = cl;
		});

		// Thickness sliders
		q(c, '.spdf-hl-thickness').oninput = function (e) { inst.highlightWidth = parseInt(e.target.value); if (inst.currentTool === 'highlight') inst.currentWidth = inst.highlightWidth; q(c, '.spdf-hl-wave').setAttribute('stroke-width', inst.highlightWidth * 2); };
		q(c, '.spdf-draw-thickness').oninput = function (e) { inst.drawWidth = parseInt(e.target.value); if (inst.currentTool === 'pen') inst.currentWidth = inst.drawWidth; q(c, '.spdf-draw-wave').setAttribute('stroke-width', inst.drawWidth); };
		q(c, '.spdf-shape-thickness').oninput = function (e) { inst.shapeWidth = parseInt(e.target.value); if (inst.currentTool === 'shape') inst.currentWidth = inst.shapeWidth; };

		// Shape buttons
		c.querySelectorAll('.spdf-shape-btn').forEach(function (btn) {
			btn.onclick = function (e) {
				e.stopPropagation();
				c.querySelectorAll('.spdf-shape-btn').forEach(function (b) { b.classList.remove('active'); });
				btn.classList.add('active');
				inst.currentShape = btn.dataset.shape;
			};
		});

		// Prevent dropdown close on inner click
		c.querySelectorAll('.spdf-dropdown').forEach(function (dd) { dd.onclick = function (e) { e.stopPropagation(); }; });

		// Context menu
		q(c, '.spdf-scroll-container').addEventListener('contextmenu', function (e) {
			e.preventDefault();
			var menu = q(c, '.spdf-context-menu');
			menu.style.left = e.clientX + 'px';
			menu.style.top = e.clientY + 'px';
			menu.classList.add('visible');
		});
		document.addEventListener('click', function () { q(c, '.spdf-context-menu').classList.remove('visible'); });
		q(c, '.spdf-context-menu').addEventListener('click', function (e) {
			var item = e.target.closest('.spdf-context-menu-item');
			if (!item) return;
			var a = item.dataset.action;
			if (a === 'highlight') setTool(inst, 'highlight');
			else if (a === 'pen') setTool(inst, 'pen');
			else if (a === 'text') setTool(inst, 'text');
			else if (a === 'zoomIn') { inst.zoomLevel = Math.min(inst.zoomLevel + 100, 1600); applyZoom(inst); }
			else if (a === 'zoomOut') { inst.zoomLevel = Math.max(inst.zoomLevel - 100, 300); applyZoom(inst); }
			else if (a === 'sepia') toggleSepia(inst);
		});

		// Selection toolbar
		q(c, '.spdf-selection-toolbar').addEventListener('click', function (e) {
			var btn = e.target.closest('button');
			if (!btn) return;
			var a = btn.dataset.action;
			if (a === 'copy') { copySelected(inst); showToast(inst, 'Kopyalandi!'); }
			else if (a === 'duplicate') { copySelected(inst); pasteAnnotation(inst); showToast(inst, 'Cogaltildi!'); }
			else if (a === 'delete') { deleteSelected(inst); showToast(inst, 'Silindi!'); }
		});

		// Scroll tracking
		q(c, '.spdf-scroll-container').addEventListener('scroll', function () { updatePageFromScroll(inst); });

		// Ctrl+wheel zoom
		q(c, '.spdf-scroll-container').addEventListener('wheel', function (e) {
			if (e.ctrlKey) {
				e.preventDefault();
				inst.zoomLevel = e.deltaY < 0 ? Math.min(inst.zoomLevel + 50, 1600) : Math.max(inst.zoomLevel - 50, 300);
				applyZoom(inst);
			}
		}, { passive: false });

		// Keyboard (once globally)
		if (!keydownListenerAdded) {
			document.addEventListener('keydown', function (e) { handleKeyboard(e); });
			keydownListenerAdded = true;
		}
	}

	// ==========================================
	// TOOL MANAGEMENT
	// ==========================================

	function setTool(inst, tool) {
		saveAllAnnotations(inst);

		if (inst.currentTool === tool) {
			inst.currentTool = null;
		} else {
			inst.currentTool = tool;
			if (tool === 'highlight') { inst.currentColor = inst.highlightColor; inst.currentWidth = inst.highlightWidth; }
			else if (tool === 'pen') { inst.currentColor = inst.drawColor; inst.currentWidth = inst.drawWidth; }
			else if (tool === 'shape') { inst.currentColor = inst.shapeColor; inst.currentWidth = inst.shapeWidth; }
		}

		var c = inst.container;
		q(c, '.spdf-highlight-wrap').classList.toggle('active', inst.currentTool === 'highlight');
		q(c, '.spdf-draw-wrap').classList.toggle('active', inst.currentTool === 'pen');
		q(c, '.spdf-shapes-wrap').classList.toggle('active', inst.currentTool === 'shape');
		q(c, '.spdf-btn-eraser').classList.toggle('active', inst.currentTool === 'eraser');
		q(c, '.spdf-btn-text').classList.toggle('active', inst.currentTool === 'text');
		q(c, '.spdf-btn-select').classList.toggle('active', inst.currentTool === 'select');

		var isAnnotating = inst.currentTool !== null;
		c.querySelectorAll('.spdf-annotation-layer').forEach(function (layer) {
			layer.classList.toggle('active', isAnnotating && inst.currentTool !== 'select');
			layer.classList.toggle('select-mode', inst.currentTool === 'select');
		});
		c.querySelectorAll('.spdf-page-overlay').forEach(function (o) {
			o.classList.toggle('drawing-active', isAnnotating);
		});

		if (inst.currentTool !== 'select') clearSelection(inst);
	}

	// ==========================================
	// SERVER COMMUNICATION
	// ==========================================

	function fetchPdfInfo(inst) {
		fetch(config.relative_path + '/api/secure-pdf/info?token=' + encodeURIComponent(inst.token), {
			headers: { 'x-csrf-token': config.csrf_token },
		})
			.then(function (r) { return r.json(); })
			.then(function (data) {
				if (!data || !data.response || !data.response.numPages) throw new Error('Failed');
				inst.totalPages = data.response.numPages;
				var c = inst.container;
				q(c, '.spdf-page-count').textContent = '/ ' + inst.totalPages;
				q(c, '.spdf-page-input').max = inst.totalPages;
				q(c, '.spdf-status-text').textContent = 'Sayfa 1 / ' + inst.totalPages;
				createPageSlots(inst);
				initLazyLoading(inst);
				generateThumbnails(inst);
			})
			.catch(function (err) {
				console.error('PDF info error:', err);
				var pc = q(inst.container, '.spdf-pages-container');
				if (pc) pc.innerHTML = '<div class="spdf-error"><div class="spdf-error-icon">\u26A0\uFE0F</div><div class="spdf-error-text">PDF bilgisi alinamadi</div></div>';
			});
	}

	// ==========================================
	// PAGE SLOTS & LAZY LOADING
	// ==========================================

	function createPageSlots(inst) {
		var pc = q(inst.container, '.spdf-pages-container');
		if (!pc) return;
		var freeLimit = inst.options.freePageLimit || -1;
		var hasAccess = inst.options.hasFullAccess;
		pc.innerHTML = '';
		inst.loadedPages = {};

		for (var p = 1; p <= inst.totalPages; p++) {
			if (!hasAccess && freeLimit > 0 && p > freeLimit) {
				var ld = document.createElement('div');
				ld.className = 'spdf-page-slot';
				ld.setAttribute('data-page', p);
				ld.style.paddingBottom = '141%';
				ld.innerHTML = '<div class="spdf-page-overlay"></div><div class="spdf-lock-overlay"><div class="spdf-lock-content"><div class="spdf-lock-icon">&#128274;</div><div class="spdf-lock-title">Premium Content</div><div class="spdf-lock-text">Premium uyeliginiz olmalidir.</div><a href="/groups/premium" class="spdf-lock-btn">Premium Ol</a></div></div>';
				pc.appendChild(ld);
				continue;
			}
			var s = document.createElement('div');
			s.className = 'spdf-page-slot spdf-loadable';
			s.setAttribute('data-page', p);
			s.style.paddingBottom = '141%';
			s.innerHTML = '<div class="spdf-page-overlay"></div><div class="spdf-page-loading"><div class="spdf-spinner"></div></div><div class="spdf-page-num">' + p + '</div>';
			pc.appendChild(s);
		}
	}

	function initLazyLoading(inst) {
		if (inst.observer) inst.observer.disconnect();
		var sc = q(inst.container, '.spdf-scroll-container');

		inst.observer = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (!entry.isIntersecting) return;
				var slot = entry.target;
				var pn = parseInt(slot.getAttribute('data-page'));
				if (!pn || inst.loadedPages[pn]) return;
				inst.loadedPages[pn] = true;
				loadPageImage(inst, pn, slot);
			});
		}, { root: sc, rootMargin: '800px 0px', threshold: 0 });

		inst.container.querySelectorAll('.spdf-page-slot.spdf-loadable').forEach(function (s) { inst.observer.observe(s); });
	}

	function loadPageImage(inst, pageNum, slot) {
		var url = config.relative_path + '/api/secure-pdf/page?token=' + encodeURIComponent(inst.token) + '&page=' + pageNum;
		fetch(url, { headers: { 'x-csrf-token': config.csrf_token } })
			.then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
			.then(function (blob) {
				var objectUrl = URL.createObjectURL(blob);
				var img = new Image();
				img.onload = function () {
					var w = img.naturalWidth, h = img.naturalHeight;
					inst.pageDimensions[pageNum] = { width: w, height: h };
					slot.style.paddingBottom = (h / w * 100) + '%';
					slot.style.backgroundImage = 'url(' + objectUrl + ')';
					slot.classList.add('spdf-loaded');
					var ld = slot.querySelector('.spdf-page-loading');
					if (ld) ld.remove();
					if (inst.observer) inst.observer.unobserve(slot);
					injectAnnotationLayer(inst, pageNum, slot, w, h);
					if (inst.sepiaMode) slot.classList.add('sepia');
				};
				img.src = objectUrl;
			})
			.catch(function (err) {
				console.error('Page load error:', err);
				var ld = slot.querySelector('.spdf-page-loading');
				if (ld) ld.innerHTML = 'Sayfa ' + pageNum + ' — yuklenemedi';
				inst.loadedPages[pageNum] = false;
			});
	}

	// ==========================================
	// ANNOTATION LAYER
	// ==========================================

	function injectAnnotationLayer(inst, pageNum, slot, w, h) {
		var old = slot.querySelector('.spdf-annotation-layer');
		if (old) old.remove();

		var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'spdf-annotation-layer');
		svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
		svg.setAttribute('preserveAspectRatio', 'none');
		svg.style.width = '100%';
		svg.style.height = '100%';
		svg.dataset.page = pageNum;
		svg.dataset.vw = w;
		svg.dataset.vh = h;

		if (inst.annotationsStore.has(pageNum)) svg.innerHTML = inst.annotationsStore.get(pageNum);
		if (inst.currentTool && inst.currentTool !== 'select') svg.classList.add('active');
		if (inst.currentTool === 'select') svg.classList.add('select-mode');

		svg.addEventListener('mousedown', function (e) { startDraw(inst, e, pageNum); });
		svg.addEventListener('mousemove', function (e) { draw(inst, e); });
		svg.addEventListener('mouseup', function () { stopDraw(inst, pageNum); });
		svg.addEventListener('mouseleave', function () { stopDraw(inst, pageNum); });
		svg.addEventListener('touchstart', function (e) { if (inst.currentTool) e.preventDefault(); startDraw(inst, e, pageNum); }, { passive: false });
		svg.addEventListener('touchmove', function (e) { if (inst.currentTool) e.preventDefault(); draw(inst, e); }, { passive: false });
		svg.addEventListener('touchend', function () { stopDraw(inst, pageNum); });

		slot.appendChild(svg);
	}

	function saveAnnotations(inst, pn) {
		var slot = inst.container.querySelector('.spdf-page-slot[data-page="' + pn + '"]');
		var svg = slot ? slot.querySelector('.spdf-annotation-layer') : null;
		if (svg && svg.innerHTML.trim()) inst.annotationsStore.set(pn, svg.innerHTML);
		else if (svg) inst.annotationsStore.delete(pn);
	}

	function saveAllAnnotations(inst) {
		inst.container.querySelectorAll('.spdf-annotation-layer').forEach(function (svg) {
			var pn = parseInt(svg.dataset.page);
			if (pn) {
				if (svg.innerHTML.trim()) inst.annotationsStore.set(pn, svg.innerHTML);
				else inst.annotationsStore.delete(pn);
			}
		});
	}

	// ==========================================
	// DRAWING
	// ==========================================

	function getCoords(e) {
		if (e.touches && e.touches.length) return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
		if (e.changedTouches && e.changedTouches.length) return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
		return { clientX: e.clientX, clientY: e.clientY };
	}

	function svgCoords(svg, e) {
		var r = svg.getBoundingClientRect();
		var vw = parseFloat(svg.dataset.vw), vh = parseFloat(svg.dataset.vh);
		var sx = vw / r.width, sy = vh / r.height;
		var p = getCoords(e);
		return { x: (p.clientX - r.left) * sx, y: (p.clientY - r.top) * sy, sx: sx, sy: sy };
	}

	function startDraw(inst, e, pn) {
		if (!inst.currentTool) return;
		e.preventDefault();
		var svg = e.currentTarget;
		if (!svg || !svg.dataset.vw) return;

		if (inst.currentTool === 'select') { handleSelectDown(inst, e, svg, pn); return; }

		var c = svgCoords(svg, e);

		if (inst.currentTool === 'eraser') {
			eraseAt(svg, c.x, c.y, c.sx);
			inst.isDrawing = true; inst.currentSvg = svg; inst.currentDrawingPage = pn;
			saveAnnotations(inst, pn);
			return;
		}

		if (inst.currentTool === 'text') {
			var p = getCoords(e);
			if (e.target.tagName === 'text') startTextDrag(inst, e, e.target, svg, c.sx, c.sy, pn);
			else showTextEditor(inst, p.clientX, p.clientY, svg, c.x, c.y, c.sx, pn);
			return;
		}

		inst.isDrawing = true; inst.currentDrawingPage = pn; inst.currentSvg = svg;

		if (inst.currentTool === 'shape') {
			svg.dataset.shapeStartX = c.x; svg.dataset.shapeStartY = c.y; svg.dataset.shapeSx = c.sx;
			var el;
			if (inst.currentShape === 'rectangle') {
				el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
				el.setAttribute('x', c.x); el.setAttribute('y', c.y); el.setAttribute('width', 0); el.setAttribute('height', 0);
			} else if (inst.currentShape === 'circle') {
				el = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
				el.setAttribute('cx', c.x); el.setAttribute('cy', c.y); el.setAttribute('rx', 0); el.setAttribute('ry', 0);
			} else {
				el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
				el.setAttribute('x1', c.x); el.setAttribute('y1', c.y); el.setAttribute('x2', c.x); el.setAttribute('y2', c.y);
			}
			el.setAttribute('stroke', inst.currentColor); el.setAttribute('stroke-width', inst.currentWidth * c.sx); el.setAttribute('fill', 'none');
			el.classList.add('current-shape');
			svg.appendChild(el);
			return;
		}

		inst.currentPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		inst.currentPath.setAttribute('stroke', inst.currentColor); inst.currentPath.setAttribute('fill', 'none');
		if (inst.currentTool === 'highlight') {
			inst.currentPath.setAttribute('stroke-width', String(inst.currentWidth * 5 * c.sx));
			inst.currentPath.setAttribute('stroke-opacity', '0.35');
		} else {
			inst.currentPath.setAttribute('stroke-width', String(inst.currentWidth * c.sx));
			inst.currentPath.setAttribute('stroke-opacity', '1');
		}
		inst.currentPath.setAttribute('d', 'M' + c.x.toFixed(2) + ',' + c.y.toFixed(2));
		svg.appendChild(inst.currentPath);
	}

	function draw(inst, e) {
		if (!inst.isDrawing || !inst.currentSvg) return;
		e.preventDefault();
		var c = svgCoords(inst.currentSvg, e);

		if (inst.currentTool === 'eraser') { eraseAt(inst.currentSvg, c.x, c.y, c.sx); return; }

		if (inst.currentTool === 'shape') {
			var el = inst.currentSvg.querySelector('.current-shape');
			if (!el) return;
			var sx = parseFloat(inst.currentSvg.dataset.shapeStartX), sy = parseFloat(inst.currentSvg.dataset.shapeStartY);
			if (inst.currentShape === 'rectangle') {
				el.setAttribute('x', Math.min(c.x, sx)); el.setAttribute('y', Math.min(c.y, sy));
				el.setAttribute('width', Math.abs(c.x - sx)); el.setAttribute('height', Math.abs(c.y - sy));
			} else if (inst.currentShape === 'circle') {
				el.setAttribute('cx', (sx + c.x) / 2); el.setAttribute('cy', (sy + c.y) / 2);
				el.setAttribute('rx', Math.abs(c.x - sx) / 2); el.setAttribute('ry', Math.abs(c.y - sy) / 2);
			} else { el.setAttribute('x2', c.x); el.setAttribute('y2', c.y); }
			return;
		}

		if (inst.currentPath) {
			inst.currentPath.setAttribute('d', inst.currentPath.getAttribute('d') + ' L' + c.x.toFixed(2) + ',' + c.y.toFixed(2));
		}
	}

	function stopDraw(inst, pn) {
		if (inst.currentTool === 'shape' && inst.currentShape === 'arrow' && inst.currentSvg) {
			var el = inst.currentSvg.querySelector('.current-shape');
			if (el && el.tagName === 'line') {
				var x1 = +el.getAttribute('x1'), y1 = +el.getAttribute('y1'), x2 = +el.getAttribute('x2'), y2 = +el.getAttribute('y2');
				var angle = Math.atan2(y2 - y1, x2 - x1);
				var hl = 15 * parseFloat(inst.currentSvg.dataset.shapeSx || 1);
				var ah = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				ah.setAttribute('d', 'M' + x2 + ',' + y2 + ' L' + (x2 - hl * Math.cos(angle - Math.PI / 6)) + ',' + (y2 - hl * Math.sin(angle - Math.PI / 6)) + ' M' + x2 + ',' + y2 + ' L' + (x2 - hl * Math.cos(angle + Math.PI / 6)) + ',' + (y2 - hl * Math.sin(angle + Math.PI / 6)));
				ah.setAttribute('stroke', el.getAttribute('stroke')); ah.setAttribute('stroke-width', el.getAttribute('stroke-width')); ah.setAttribute('fill', 'none');
				inst.currentSvg.appendChild(ah);
			}
		}
		if (inst.currentSvg) { var s = inst.currentSvg.querySelector('.current-shape'); if (s) s.classList.remove('current-shape'); }
		if (inst.isDrawing && inst.currentDrawingPage) saveAnnotations(inst, inst.currentDrawingPage);
		inst.isDrawing = false; inst.currentPath = null; inst.currentSvg = null; inst.currentDrawingPage = null;
	}

	function eraseAt(svg, x, y, scale) {
		var hr = 15 * scale;
		svg.querySelectorAll('path, text, rect, ellipse, line').forEach(function (el) {
			var b = el.getBBox();
			if (x >= b.x - hr && x <= b.x + b.width + hr && y >= b.y - hr && y <= b.y + b.height + hr) el.remove();
		});
	}

	// ==========================================
	// TEXT TOOL
	// ==========================================

	function startTextDrag(inst, e, textEl, svg, sx, sy, pn) {
		e.preventDefault(); e.stopPropagation();
		textEl.classList.add('dragging');
		var start = getCoords(e);
		var ox = parseFloat(textEl.getAttribute('x')), oy = parseFloat(textEl.getAttribute('y'));
		var dragged = false;

		function onMove(ev) {
			var dx = (ev.clientX - start.clientX) * sx, dy = (ev.clientY - start.clientY) * sy;
			if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragged = true;
			textEl.setAttribute('x', (ox + dx).toFixed(2)); textEl.setAttribute('y', (oy + dy).toFixed(2));
		}
		function onUp(ev) {
			document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
			textEl.classList.remove('dragging');
			if (dragged) saveAnnotations(inst, pn);
			else showTextEditor(inst, ev.clientX, ev.clientY, svg, parseFloat(textEl.getAttribute('x')), parseFloat(textEl.getAttribute('y')), sx, pn, textEl);
		}
		document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
	}

	function showTextEditor(inst, screenX, screenY, svg, svgX, svgY, scale, pn, existing) {
		var old = document.querySelector('.spdf-text-editor-overlay');
		if (old) old.remove();
		var color = (existing && existing.getAttribute('fill')) || inst.currentColor;
		var editText = existing ? existing.textContent : null;
		if (existing) inst.textFontSize = parseFloat(existing.getAttribute('font-size')) / scale || 14;

		var overlay = document.createElement('div'); overlay.className = 'spdf-text-editor-overlay';
		var box = document.createElement('div'); box.className = 'spdf-text-editor-box'; box.style.left = screenX + 'px'; box.style.top = screenY + 'px';
		var input = document.createElement('div'); input.className = 'spdf-text-editor-input'; input.contentEditable = true; input.style.color = color; input.style.fontSize = inst.textFontSize + 'px';
		if (editText) input.textContent = editText;

		var tb = document.createElement('div'); tb.className = 'spdf-text-editor-toolbar';
		var decBtn = document.createElement('button'); decBtn.className = 'spdf-text-editor-btn'; decBtn.innerHTML = 'A<sup>-</sup>';
		decBtn.onclick = function (e) { e.stopPropagation(); if (inst.textFontSize > 10) { inst.textFontSize -= 2; input.style.fontSize = inst.textFontSize + 'px'; } };
		var incBtn = document.createElement('button'); incBtn.className = 'spdf-text-editor-btn'; incBtn.innerHTML = 'A<sup>+</sup>';
		incBtn.onclick = function (e) { e.stopPropagation(); if (inst.textFontSize < 32) { inst.textFontSize += 2; input.style.fontSize = inst.textFontSize + 'px'; } };
		var delBtn = document.createElement('button'); delBtn.className = 'spdf-text-editor-btn delete'; delBtn.textContent = '\uD83D\uDDD1\uFE0F';
		delBtn.onclick = function (e) { e.stopPropagation(); if (existing) { existing.remove(); saveAnnotations(inst, pn); } overlay.remove(); };

		tb.appendChild(decBtn); tb.appendChild(incBtn); tb.appendChild(delBtn);
		box.appendChild(input); box.appendChild(tb); overlay.appendChild(box); document.body.appendChild(overlay);
		setTimeout(function () { input.focus(); if (editText) { var r = document.createRange(); r.selectNodeContents(input); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } }, 50);

		function confirm() {
			var t = input.textContent.trim();
			if (t) {
				if (existing) { existing.textContent = t; existing.setAttribute('fill', color); existing.setAttribute('font-size', String(inst.textFontSize * scale)); }
				else {
					var te = document.createElementNS('http://www.w3.org/2000/svg', 'text');
					te.setAttribute('x', svgX.toFixed(2)); te.setAttribute('y', svgY.toFixed(2));
					te.setAttribute('fill', color); te.setAttribute('font-size', String(inst.textFontSize * scale));
					te.setAttribute('font-family', 'Segoe UI, Arial, sans-serif'); te.textContent = t;
					svg.appendChild(te);
				}
				saveAnnotations(inst, pn);
			} else if (existing) { existing.remove(); saveAnnotations(inst, pn); }
			overlay.remove();
		}
		overlay.addEventListener('click', function (e) { if (e.target === overlay) confirm(); });
		input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirm(); } if (e.key === 'Escape') overlay.remove(); });
	}

	// ==========================================
	// SELECT / MOVE
	// ==========================================

	function handleSelectDown(inst, e, svg, pn) {
		var target = e.target;
		if (target === svg || target.tagName === 'svg') { clearSelection(inst); return; }
		if (!target.closest('.spdf-annotation-layer')) return;

		e.preventDefault(); e.stopPropagation();
		selectAnnotation(inst, target, svg, pn);

		var coords = getCoords(e);
		inst.isDraggingAnnotation = true; inst.dragStartX = coords.clientX; inst.dragStartY = coords.clientY;
		target.classList.add('annotation-dragging');

		function onMove(ev) {
			if (!inst.isDraggingAnnotation) return;
			ev.preventDefault();
			var mc = getCoords(ev);
			var r = svg.getBoundingClientRect();
			var dx = (mc.clientX - inst.dragStartX) * (parseFloat(svg.dataset.vw) / r.width);
			var dy = (mc.clientY - inst.dragStartY) * (parseFloat(svg.dataset.vh) / r.height);
			moveAnnotation(target, dx, dy);
			inst.dragStartX = mc.clientX; inst.dragStartY = mc.clientY;
		}
		function onEnd() {
			document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onEnd);
			document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onEnd);
			target.classList.remove('annotation-dragging');
			inst.isDraggingAnnotation = false;
			saveAnnotations(inst, pn);
		}
		document.addEventListener('mousemove', onMove, { passive: false }); document.addEventListener('mouseup', onEnd);
		document.addEventListener('touchmove', onMove, { passive: false }); document.addEventListener('touchend', onEnd);
	}

	function moveAnnotation(el, dx, dy) {
		if (el.tagName === 'path') {
			var t = el.getAttribute('transform') || '', m = t.match(/translate\(([^,]+),\s*([^)]+)\)/);
			var tx = m ? parseFloat(m[1]) : 0, ty = m ? parseFloat(m[2]) : 0;
			el.setAttribute('transform', 'translate(' + (tx + dx) + ',' + (ty + dy) + ')');
		} else if (el.tagName === 'rect') {
			el.setAttribute('x', parseFloat(el.getAttribute('x')) + dx); el.setAttribute('y', parseFloat(el.getAttribute('y')) + dy);
		} else if (el.tagName === 'ellipse') {
			el.setAttribute('cx', parseFloat(el.getAttribute('cx')) + dx); el.setAttribute('cy', parseFloat(el.getAttribute('cy')) + dy);
		} else if (el.tagName === 'line') {
			el.setAttribute('x1', +el.getAttribute('x1') + dx); el.setAttribute('y1', +el.getAttribute('y1') + dy);
			el.setAttribute('x2', +el.getAttribute('x2') + dx); el.setAttribute('y2', +el.getAttribute('y2') + dy);
		} else if (el.tagName === 'text') {
			el.setAttribute('x', parseFloat(el.getAttribute('x')) + dx); el.setAttribute('y', parseFloat(el.getAttribute('y')) + dy);
		}
	}

	function selectAnnotation(inst, el, svg, pn) {
		clearSelection(inst);
		inst.selectedAnnotation = el; inst.selectedSvg = svg; inst.selectedPageNum = pn;
		el.classList.add('annotation-selected');
		q(inst.container, '.spdf-selection-toolbar').classList.add('visible');
	}

	function clearSelection(inst) {
		if (inst.selectedAnnotation) inst.selectedAnnotation.classList.remove('annotation-selected', 'annotation-dragging');
		inst.selectedAnnotation = null; inst.selectedSvg = null; inst.selectedPageNum = null;
		inst.isDraggingAnnotation = false;
		q(inst.container, '.spdf-selection-toolbar').classList.remove('visible');
	}

	function deleteSelected(inst) {
		if (inst.selectedAnnotation) { inst.selectedAnnotation.remove(); saveAnnotations(inst, inst.selectedPageNum); clearSelection(inst); }
	}

	function copySelected(inst) {
		if (inst.selectedAnnotation) {
			inst.copiedAnnotation = inst.selectedAnnotation.cloneNode(true);
			inst.copiedAnnotation.classList.remove('annotation-selected', 'annotation-dragging');
		}
	}

	function pasteAnnotation(inst) {
		if (!inst.copiedAnnotation) return;
		var pn = getCurrentPage(inst);
		var slot = inst.container.querySelector('.spdf-page-slot[data-page="' + pn + '"]');
		var svg = slot ? slot.querySelector('.spdf-annotation-layer') : null;
		if (!svg) return;
		var cl = inst.copiedAnnotation.cloneNode(true);
		var off = 30;
		if (cl.tagName === 'path') {
			var t = cl.getAttribute('transform') || '', m = t.match(/translate\(([^,]+),\s*([^)]+)\)/);
			cl.setAttribute('transform', 'translate(' + ((m ? parseFloat(m[1]) : 0) + off) + ',' + ((m ? parseFloat(m[2]) : 0) + off) + ')');
		} else if (cl.tagName === 'rect') { cl.setAttribute('x', +cl.getAttribute('x') + off); cl.setAttribute('y', +cl.getAttribute('y') + off); }
		else if (cl.tagName === 'ellipse') { cl.setAttribute('cx', +cl.getAttribute('cx') + off); cl.setAttribute('cy', +cl.getAttribute('cy') + off); }
		else if (cl.tagName === 'line') { cl.setAttribute('x1', +cl.getAttribute('x1') + off); cl.setAttribute('y1', +cl.getAttribute('y1') + off); cl.setAttribute('x2', +cl.getAttribute('x2') + off); cl.setAttribute('y2', +cl.getAttribute('y2') + off); }
		else if (cl.tagName === 'text') { cl.setAttribute('x', +cl.getAttribute('x') + off); cl.setAttribute('y', +cl.getAttribute('y') + off); }
		svg.appendChild(cl);
		saveAnnotations(inst, pn);
		selectAnnotation(inst, cl, svg, pn);
	}

	// ==========================================
	// THUMBNAILS
	// ==========================================

	function generateThumbnails(inst) {
		var tc = q(inst.container, '.spdf-thumbnail-container');
		if (!tc) return;
		tc.innerHTML = '';

		for (var i = 1; i <= inst.totalPages; i++) {
			var th = document.createElement('div');
			th.className = 'spdf-thumbnail' + (i === 1 ? ' active' : '');
			th.dataset.page = i;
			th.innerHTML = '<div class="spdf-thumbnail-num">' + i + '</div>';
			th.style.minHeight = '80px';

			(function (pn, el) {
				el.onclick = function () {
					scrollToPage(inst, pn);
					tc.querySelectorAll('.spdf-thumbnail').forEach(function (t) { t.classList.remove('active'); });
					el.classList.add('active');
				};
			})(i, th);
			tc.appendChild(th);
		}

		var to = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (!entry.isIntersecting) return;
				var el = entry.target;
				var pn = parseInt(el.dataset.page);
				if (el.querySelector('img')) return;
				var img = document.createElement('img');
				img.src = config.relative_path + '/api/secure-pdf/page?token=' + encodeURIComponent(inst.token) + '&page=' + pn;
				img.style.width = '100%'; img.style.display = 'block';
				el.insertBefore(img, el.firstChild);
				to.unobserve(el);
			});
		}, { root: tc, rootMargin: '200px 0px' });

		tc.querySelectorAll('.spdf-thumbnail').forEach(function (t) { to.observe(t); });
	}

	// ==========================================
	// NAVIGATION & VIEW
	// ==========================================

	function applyZoom(inst) {
		inst.container.querySelectorAll('.spdf-page-slot').forEach(function (p) { p.style.maxWidth = inst.zoomLevel + 'px'; });
	}

	function scrollToPage(inst, pn) {
		var slot = inst.container.querySelector('.spdf-page-slot[data-page="' + pn + '"]');
		if (slot) slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function rotatePage(inst, delta) {
		var pn = getCurrentPage(inst);
		var cur = inst.pageRotations.get(pn) || 0;
		var nr = (cur + delta + 360) % 360;
		inst.pageRotations.set(pn, nr);
		var slot = inst.container.querySelector('.spdf-page-slot[data-page="' + pn + '"]');
		if (slot) slot.style.transform = nr ? 'rotate(' + nr + 'deg)' : '';
	}

	function toggleSepia(inst) {
		inst.sepiaMode = !inst.sepiaMode;
		q(inst.container, '.spdf-scroll-container').classList.toggle('sepia', inst.sepiaMode);
		inst.container.querySelectorAll('.spdf-page-slot.spdf-loaded').forEach(function (p) { p.classList.toggle('sepia', inst.sepiaMode); });
		q(inst.container, '.spdf-btn-sepia').classList.toggle('active', inst.sepiaMode);
	}

	function toggleSidebar(inst) {
		var sb = q(inst.container, '.spdf-thumbnail-sidebar');
		sb.classList.toggle('open');
		q(inst.container, '.spdf-scroll-container').classList.toggle('with-sidebar', sb.classList.contains('open'));
		q(inst.container, '.spdf-btn-sidebar').classList.toggle('active', sb.classList.contains('open'));
	}

	function getCurrentPage(inst) {
		var sc = q(inst.container, '.spdf-scroll-container');
		var pages = sc.querySelectorAll('.spdf-page-slot');
		var st = sc.scrollTop + sc.clientHeight / 3;
		for (var i = pages.length - 1; i >= 0; i--) {
			if (pages[i].offsetTop <= st) return parseInt(pages[i].getAttribute('data-page')) || 1;
		}
		return 1;
	}

	function updatePageFromScroll(inst) {
		var pn = getCurrentPage(inst);
		q(inst.container, '.spdf-status-text').textContent = 'Sayfa ' + pn + ' / ' + inst.totalPages;
		q(inst.container, '.spdf-page-input').value = pn;
		inst.container.querySelectorAll('.spdf-thumbnail').forEach(function (t) {
			t.classList.toggle('active', parseInt(t.dataset.page) === pn);
		});
	}

	// ==========================================
	// KEYBOARD
	// ==========================================

	function handleKeyboard(e) {
		if (e.target.tagName === 'INPUT' || e.target.contentEditable === 'true') return;
		// Find active viewer instance
		var wrapper = document.querySelector('.spdf-viewer-wrapper');
		if (!wrapper) return;

		var key = e.key.toLowerCase();

		// These shortcuts need to find the instance — stored via closure not possible
		// Use a simple approach: find the container and work with DOM
		if (key === 'h') { clickBtn(wrapper, '.spdf-btn-highlight'); e.preventDefault(); }
		if (key === 'p' && !e.ctrlKey) { clickBtn(wrapper, '.spdf-btn-draw'); e.preventDefault(); }
		if (key === 'e') { clickBtn(wrapper, '.spdf-btn-eraser'); e.preventDefault(); }
		if (key === 't') { clickBtn(wrapper, '.spdf-btn-text'); e.preventDefault(); }
		if (key === 'r') { clickBtn(wrapper, '.spdf-btn-shapes'); e.preventDefault(); }
		if (key === 'v' && !e.ctrlKey) { clickBtn(wrapper, '.spdf-btn-select'); e.preventDefault(); }
		if (key === 's' && !e.ctrlKey) { clickBtn(wrapper, '.spdf-btn-sidebar'); e.preventDefault(); }
		if (key === 'm') { clickBtn(wrapper, '.spdf-btn-sepia'); e.preventDefault(); }

		if (key === 'escape') {
			// Close dropdowns
			wrapper.querySelectorAll('.spdf-dropdown').forEach(function (d) { d.classList.remove('visible'); });
		}

		// Anti-download shortcuts (block save/print/source)
		if (e.ctrlKey || e.metaKey) {
			if (key === 's' || key === 'p' || key === 'u') { e.preventDefault(); return false; }
			if (e.shiftKey && (key === 's' || key === 'i' || key === 'j')) { e.preventDefault(); return false; }
		}
		if (e.key === 'F12') { e.preventDefault(); return false; }
	}

	function clickBtn(container, selector) {
		var btn = container.querySelector(selector);
		if (btn) btn.click();
	}

	// ==========================================
	// UTILITY
	// ==========================================

	function q(container, selector) { return container.querySelector(selector); }

	function toggleDd(inst, dropdown, e) {
		e.stopPropagation();
		var vis = dropdown.classList.contains('visible');
		closeAllDd(inst);
		if (!vis) dropdown.classList.add('visible');
	}

	function closeAllDd(inst) {
		inst.container.querySelectorAll('.spdf-dropdown').forEach(function (d) { d.classList.remove('visible'); });
	}

	function setupColors(inst, selector, callback) {
		inst.container.querySelectorAll(selector + ' .spdf-color-dot').forEach(function (dot) {
			dot.onclick = function (e) {
				e.stopPropagation();
				inst.container.querySelectorAll(selector + ' .spdf-color-dot').forEach(function (d) { d.classList.remove('active'); });
				dot.classList.add('active');
				callback(dot.dataset.color);
			};
		});
	}

	function showToast(inst, msg) {
		var old = document.querySelector('.spdf-toast');
		if (old) old.remove();
		var t = document.createElement('div'); t.className = 'spdf-toast'; t.textContent = msg;
		document.body.appendChild(t);
		setTimeout(function () { t.remove(); }, 2000);
	}

	// ==========================================
	// ANTI-DOWNLOAD PROTECTIONS
	// ==========================================

	function initAntiDownloadProtections(inst) {
		inst.container.addEventListener('contextmenu', function (e) { e.preventDefault(); return false; });
		inst.container.addEventListener('dragstart', function (e) { e.preventDefault(); return false; });
		inst.container.addEventListener('selectstart', function (e) { e.preventDefault(); return false; });
		inst.container.addEventListener('copy', function (e) { e.preventDefault(); return false; });
	}

	function initConsoleProtection() {
		var origCreate = URL.createObjectURL.bind(URL);
		var allowed = new WeakSet();
		var origFetch = window.fetch;
		window.fetch = function () {
			return origFetch.apply(this, arguments).then(function (response) {
				var origBlob = response.blob.bind(response);
				response.blob = function () { return origBlob().then(function (blob) { allowed.add(blob); return blob; }); };
				return response;
			});
		};
		URL.createObjectURL = function (blob) {
			if (allowed.has(blob)) return origCreate(blob);
			console.warn('[Secure PDF] Blob URL creation blocked');
			return '';
		};
	}

	return Viewer;
});
