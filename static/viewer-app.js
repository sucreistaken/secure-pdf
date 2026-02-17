// IIFE to prevent global access to pdfDoc, pdfViewer
(function () {
    'use strict';

    // ============================================
    // CANVAS EXPORT PROTECTION
    // Block toDataURL/toBlob for PDF render canvas only
    // Allows: thumbnails, annotations, other canvases
    // ============================================
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;

    HTMLCanvasElement.prototype.toDataURL = function () {
        // Block only main PDF page canvases (inside .page elements in #viewerContainer)
        if (this.closest && this.closest('.page') && this.closest('#viewerContainer')) {
            console.warn('[Security] Canvas toDataURL blocked for PDF page');
            return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';  // 1x1 transparent
        }
        return originalToDataURL.apply(this, arguments);
    };

    HTMLCanvasElement.prototype.toBlob = function (callback) {
        // Block only main PDF page canvases
        if (this.closest && this.closest('.page') && this.closest('#viewerContainer')) {
            console.warn('[Security] Canvas toBlob blocked for PDF page');
            // Return empty blob
            if (callback) callback(new Blob([], { type: 'image/png' }));
            return;
        }
        return originalToBlob.apply(this, arguments);
    };

    pdfjsLib.GlobalWorkerOptions.workerSrc = '';

    // State - now private, not accessible from console
    let pdfDoc = null;
    let pdfViewer = null;
    let annotationMode = false;
    let currentTool = null; // null, 'pen', 'highlight', 'eraser'
    let currentColor = '#e81224';
    let currentWidth = 2;
    let isDrawing = false;
    let currentPath = null;
    let currentDrawingPage = null;
    let pathSegments = [];
    let drawRAF = null;

    // Annotation persistence - stores SVG innerHTML per page
    const annotationsStore = new Map();
    const annotationRotations = new Map(); // tracks rotation when annotations were saved

    // AbortControllers for annotation layer event listeners (cleanup on re-inject)
    const annotationAbortControllers = new Map();  // pageNum -> AbortController

    // Undo/Redo history stacks - per page
    // Each entry: {nodes: Node[], rotation: number}
    const undoStacks = new Map();  // pageNum -> [{nodes, rotation}, ...]
    const redoStacks = new Map();  // pageNum -> [{nodes, rotation}, ...]
    const MAX_HISTORY = 30;

    // Store base dimensions (scale=1.0) for each page - ensures consistent coordinates
    const pageBaseDimensions = new Map();

    // Current SVG reference for drawing
    let currentSvg = null;

    // Elements
    const container = document.getElementById('viewerContainer');
    const uploadOverlay = document.getElementById('uploadOverlay');
    const fileInput = document.getElementById('fileInput');
    const sidebar = document.getElementById('sidebar');
    const thumbnailContainer = document.getElementById('thumbnailContainer');

    // Initialize PDFViewer
    const eventBus = new pdfjsViewer.EventBus();
    const linkService = new pdfjsViewer.PDFLinkService({ eventBus });

    pdfViewer = new pdfjsViewer.PDFViewer({
        container: container,
        eventBus: eventBus,
        linkService: linkService,
        removePageBorders: true,
        textLayerMode: 2
    });
    linkService.setViewer(pdfViewer);

    // Track first page render for queue system
    let firstPageRendered = false;
    eventBus.on('pagerendered', function (evt) {
        if (!firstPageRendered && evt.pageNumber === 1) {
            firstPageRendered = true;
            // Notify parent that PDF is fully rendered (for queue system)
            if (window.parent && window.parent !== window) {
                const config = window.PDF_SECURE_CONFIG || {};
                window.parent.postMessage({ type: 'pdf-secure-ready', filename: config.filename }, window.location.origin);
                console.log('[PDF-Secure] First page rendered, notifying parent');
            }
        }
    });

    // File Handling
    document.getElementById('dropzone').onclick = () => fileInput.click();

    fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (file) await loadPDF(file);
    };

    uploadOverlay.ondragover = (e) => e.preventDefault();
    uploadOverlay.ondrop = async (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file?.type === 'application/pdf') await loadPDF(file);
    };

    async function loadPDF(file) {
        uploadOverlay.classList.add('hidden');

        const data = await file.arrayBuffer();
        pdfDoc = await pdfjsLib.getDocument({ data }).promise;

        pdfViewer.setDocument(pdfDoc);
        linkService.setDocument(pdfDoc);

        ['zoomIn', 'zoomOut', 'pageInput', 'rotateLeft', 'rotateRight'].forEach(id => {
            document.getElementById(id).disabled = false;
        });

        // Thumbnails will be generated on-demand when sidebar opens
    }

    // Load PDF from ArrayBuffer (for secure nonce-based loading)
    async function loadPDFFromBuffer(arrayBuffer) {
        uploadOverlay.classList.add('hidden');

        pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

        pdfViewer.setDocument(pdfDoc);
        linkService.setDocument(pdfDoc);

        ['zoomIn', 'zoomOut', 'pageInput', 'rotateLeft', 'rotateRight'].forEach(id => {
            document.getElementById(id).disabled = false;
        });

        // Thumbnails will be generated on-demand when sidebar opens
    }

    // Partial XOR decoder - must match backend encoding
    function partialXorDecode(encodedData, keyBase64) {
        const key = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
        const data = new Uint8Array(encodedData);
        const keyLen = key.length;

        // Decrypt first 10KB fully
        const fullDecryptLen = Math.min(10240, data.length);
        for (let i = 0; i < fullDecryptLen; i++) {
            data[i] = data[i] ^ key[i % keyLen];
        }

        // Decrypt every 50th byte after that
        for (let i = fullDecryptLen; i < data.length; i += 50) {
            data[i] = data[i] ^ key[i % keyLen];
        }

        return data.buffer;
    }

    // Auto-load PDF if config is present (injected by NodeBB plugin)
    async function autoLoadSecurePDF() {
        if (!window.PDF_SECURE_CONFIG || !window.PDF_SECURE_CONFIG.filename) {
            console.log('[PDF-Secure] No config found, showing file picker');
            return;
        }

        const config = window.PDF_SECURE_CONFIG;
        console.log('[PDF-Secure] Auto-loading:', config.filename);

        // Show loading state
        const dropzone = document.getElementById('dropzone');
        if (dropzone) {
            dropzone.innerHTML = `
            <svg viewBox="0 0 24 24" class="spin">
                <path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z" />
            </svg>
            <h2>PDF Yükleniyor...</h2>
            <p>${config.filename}</p>
        `;
        }

        try {
            // ============================================
            // SPA CACHE - Check if parent has cached buffer
            // ============================================
            let pdfBuffer = null;

            if (window.parent && window.parent !== window) {
                // Request cached buffer from parent
                const cachePromise = new Promise((resolve) => {
                    const handler = (event) => {
                        if (event.data && event.data.type === 'pdf-secure-cache-response' && event.data.filename === config.filename) {
                            window.removeEventListener('message', handler);
                            resolve(event.data.buffer);
                        }
                    };
                    window.addEventListener('message', handler);

                    // Timeout after 100ms
                    setTimeout(() => {
                        window.removeEventListener('message', handler);
                        resolve(null);
                    }, 100);

                    window.parent.postMessage({ type: 'pdf-secure-cache-request', filename: config.filename }, window.location.origin);
                });

                pdfBuffer = await cachePromise;
                if (pdfBuffer) {
                    console.log('[PDF-Secure] Using cached buffer');
                }
            }

            // If no cache, fetch from server
            if (!pdfBuffer) {
                // Nonce and key are embedded in HTML config (not fetched from API)
                const nonce = config.nonce;
                const xorKey = config.dk;

                // Fetch encrypted PDF binary
                const pdfUrl = config.relativePath + '/api/v3/plugins/pdf-secure/pdf-data?nonce=' + encodeURIComponent(nonce);
                const pdfRes = await fetch(pdfUrl, { credentials: 'same-origin' });

                if (!pdfRes.ok) {
                    throw new Error('PDF yüklenemedi (' + pdfRes.status + ')');
                }

                const encodedBuffer = await pdfRes.arrayBuffer();
                console.log('[PDF-Secure] Encrypted data received:', encodedBuffer.byteLength, 'bytes');

                // Decode XOR encrypted data
                if (xorKey) {
                    console.log('[PDF-Secure] Decoding XOR encrypted data...');
                    pdfBuffer = partialXorDecode(encodedBuffer, xorKey);
                } else {
                    pdfBuffer = encodedBuffer;
                }

                // Send buffer to parent for caching
                if (window.parent && window.parent !== window) {
                    // Clone buffer for parent (we keep original)
                    const bufferCopy = pdfBuffer.slice(0);
                    window.parent.postMessage({
                        type: 'pdf-secure-buffer',
                        filename: config.filename,
                        buffer: bufferCopy
                    }, window.location.origin, [bufferCopy]);  // Transferable
                }
            }

            console.log('[PDF-Secure] PDF decoded successfully');

            // Step 4: Load into viewer
            await loadPDFFromBuffer(pdfBuffer);

            // Step 5: Moved to pagerendered event for proper timing

            // Step 6: Security - clear references to prevent extraction
            pdfBuffer = null;

            // Security: Delete config containing sensitive data (nonce, key)
            delete window.PDF_SECURE_CONFIG;

            // Security: Remove PDF.js globals to prevent console manipulation
            delete window.pdfjsLib;
            delete window.pdfjsViewer;

            // Security: Block dangerous PDF.js methods
            if (pdfDoc) {
                pdfDoc.getData = function () {
                    console.warn('[Security] getData() is blocked');
                    return Promise.reject(new Error('Access denied'));
                };
                pdfDoc.saveDocument = function () {
                    console.warn('[Security] saveDocument() is blocked');
                    return Promise.reject(new Error('Access denied'));
                };
            }

            console.log('[PDF-Secure] PDF fully loaded and ready');

        } catch (err) {
            console.error('[PDF-Secure] Auto-load error:', err);

            // Notify parent of error (prevents 60s queue hang)
            if (window.parent && window.parent !== window) {
                const config = window.PDF_SECURE_CONFIG || {};
                window.parent.postMessage({
                    type: 'pdf-secure-ready',
                    filename: config.filename,
                    error: err.message
                }, window.location.origin);
            }

            if (dropzone) {
                dropzone.innerHTML = `
                <svg viewBox="0 0 24 24" style="fill: #e81224;">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
                <h2>Hata</h2>
                <p>${err.message}</p>
            `;
            }
        }
    }

    // Run auto-load on page ready
    autoLoadSecurePDF();

    // Generate Thumbnails (deferred - only when sidebar opens, lazy-rendered)
    let thumbnailsGenerated = false;
    async function generateThumbnails() {
        if (thumbnailsGenerated) return;
        thumbnailsGenerated = true;
        thumbnailContainer.innerHTML = '';

        // Create placeholder thumbnails for all pages
        for (let i = 1; i <= pdfDoc.numPages; i++) {
            const thumb = document.createElement('div');
            thumb.className = 'thumbnail' + (i === 1 ? ' active' : '');
            thumb.dataset.page = i;
            thumb.innerHTML = `<div class="thumbnailNum">${i}</div>`;
            thumb.onclick = () => {
                pdfViewer.currentPageNumber = i;
                document.querySelectorAll('.thumbnail').forEach(t => t.classList.remove('active'));
                thumb.classList.add('active');
            };
            thumbnailContainer.appendChild(thumb);
        }

        // Lazy render thumbnails with IntersectionObserver
        const thumbObserver = new IntersectionObserver((entries) => {
            entries.forEach(async (entry) => {
                if (entry.isIntersecting && !entry.target.dataset.rendered) {
                    entry.target.dataset.rendered = 'true';
                    const pageNum = parseInt(entry.target.dataset.page);
                    const page = await pdfDoc.getPage(pageNum);
                    const viewport = page.getViewport({ scale: 0.2 });
                    const canvas = document.createElement('canvas');
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
                    entry.target.insertBefore(canvas, entry.target.firstChild);
                }
            });
        }, { root: thumbnailContainer, rootMargin: '200px' });

        thumbnailContainer.querySelectorAll('.thumbnail').forEach(t => thumbObserver.observe(t));
    }

    // Events
    eventBus.on('pagesinit', () => {
        pdfViewer.currentScaleValue = 'page-width';
        document.getElementById('pageCount').textContent = `/ ${pdfViewer.pagesCount}`;
    });

    eventBus.on('pagechanging', (evt) => {
        document.getElementById('pageInput').value = evt.pageNumber;
        // Update active thumbnail
        document.querySelectorAll('.thumbnail').forEach(t => {
            t.classList.toggle('active', parseInt(t.dataset.page) === evt.pageNumber);
        });
        // Update undo/redo buttons for new page
        updateUndoRedoButtons();

        // Bug fix: Clear selection on page change (stale SVG reference)
        clearAnnotationSelection();

        // Bug fix: Reset drawing state on page change
        if (isDrawing && currentDrawingPage) {
            saveAnnotations(currentDrawingPage);
        }
        isDrawing = false;
        currentPath = null;
        currentSvg = null;
        currentDrawingPage = null;
    });

    eventBus.on('pagerendered', (evt) => {
        injectAnnotationLayer(evt.pageNumber);

        // Rotation is handled natively by PDF.js via pagesRotation
    });

    // Page Navigation
    document.getElementById('pageInput').onchange = (e) => {
        const num = parseInt(e.target.value);
        if (num >= 1 && num <= pdfViewer.pagesCount) {
            pdfViewer.currentPageNumber = num;
        }
    };

    // Zoom
    document.getElementById('zoomIn').onclick = () => pdfViewer.currentScale += 0.25;
    document.getElementById('zoomOut').onclick = () => pdfViewer.currentScale -= 0.25;

    // Sidebar toggle (deferred thumbnail generation)
    const sidebarEl = document.getElementById('sidebar');
    const sidebarBtnEl = document.getElementById('sidebarBtn');
    const closeSidebarBtn = document.getElementById('closeSidebar');

    sidebarBtnEl.onclick = () => {
        const isOpening = !sidebarEl.classList.contains('open');
        sidebarEl.classList.toggle('open');
        sidebarBtnEl.classList.toggle('active');
        container.classList.toggle('withSidebar', sidebarEl.classList.contains('open'));

        // Generate thumbnails on first open (deferred loading)
        if (isOpening && pdfDoc) {
            generateThumbnails();
        }
    };

    closeSidebarBtn.onclick = () => {
        sidebarEl.classList.remove('open');
        sidebarBtnEl.classList.remove('active');
        container.classList.remove('withSidebar');
    };

    // Sepia Reading Mode
    let sepiaMode = false;
    document.getElementById('sepiaBtn').onclick = () => {
        sepiaMode = !sepiaMode;
        document.getElementById('viewer').classList.toggle('sepia', sepiaMode);
        container.classList.toggle('sepia', sepiaMode);
        document.getElementById('sepiaBtn').classList.toggle('active', sepiaMode);
    };

    // Page Rotation — uses PDF.js native rotation (re-renders at correct size & quality)
    function rotatePage(delta) {
        const current = pdfViewer.pagesRotation || 0;
        // Clear cached dimensions so they get recalculated with new rotation
        pageBaseDimensions.clear();
        pdfViewer.pagesRotation = (current + delta + 360) % 360;
    }

    document.getElementById('rotateLeft').onclick = () => rotatePage(-90);
    document.getElementById('rotateRight').onclick = () => rotatePage(90);




    // Tool settings - separate for each tool
    let highlightColor = '#fff100';
    let highlightWidth = 4;
    let drawColor = '#e81224';
    let drawWidth = 2;
    let shapeColor = '#e81224';
    let shapeWidth = 2;
    let currentShape = 'rectangle'; // rectangle, circle, line, arrow

    // Dropdown Panel Logic
    const highlightDropdown = document.getElementById('highlightDropdown');
    const drawDropdown = document.getElementById('drawDropdown');
    const shapesDropdown = document.getElementById('shapesDropdown');
    const highlightWrapper = document.getElementById('highlightWrapper');
    const drawWrapper = document.getElementById('drawWrapper');
    const shapesWrapper = document.getElementById('shapesWrapper');

    const dropdownBackdrop = document.getElementById('dropdownBackdrop');
    const overflowDropdown = document.getElementById('overflowDropdown');

    function closeAllDropdowns() {
        highlightDropdown.classList.remove('visible');
        drawDropdown.classList.remove('visible');
        shapesDropdown.classList.remove('visible');
        overflowDropdown.classList.remove('visible');
        dropdownBackdrop.classList.remove('visible');
    }

    function toggleDropdown(dropdown, e) {
        e.stopPropagation();
        const isVisible = dropdown.classList.contains('visible');
        closeAllDropdowns();
        if (!isVisible) {
            const useBottomSheet = isMobile() || isTabletPortrait();
            // Add drag handle for mobile/tablet portrait bottom sheets
            if (useBottomSheet && !dropdown.querySelector('.bottomSheetHandle')) {
                const handle = document.createElement('div');
                handle.className = 'bottomSheetHandle';
                dropdown.insertBefore(handle, dropdown.firstChild);
            }
            dropdown.classList.add('visible');
            // Show backdrop on mobile/tablet portrait
            if (useBottomSheet) {
                dropdownBackdrop.classList.add('visible');
            }
        }
    }

    // Backdrop click closes dropdowns
    dropdownBackdrop.addEventListener('click', () => {
        closeAllDropdowns();
    });

    // Arrow buttons toggle dropdowns
    document.getElementById('highlightArrow').onclick = (e) => toggleDropdown(highlightDropdown, e);
    document.getElementById('drawArrow').onclick = (e) => toggleDropdown(drawDropdown, e);
    document.getElementById('shapesArrow').onclick = (e) => toggleDropdown(shapesDropdown, e);

    // Overflow menu toggle
    document.getElementById('overflowBtn').onclick = (e) => toggleDropdown(overflowDropdown, e);
    overflowDropdown.onclick = (e) => e.stopPropagation();

    // Overflow menu actions
    document.getElementById('overflowRotateLeft').onclick = () => {
        rotatePage(-90);
        closeAllDropdowns();
    };
    document.getElementById('overflowRotateRight').onclick = () => {
        rotatePage(90);
        closeAllDropdowns();
    };
    document.getElementById('overflowSepia').onclick = () => {
        document.getElementById('sepiaBtn').click();
        document.getElementById('overflowSepia').classList.toggle('active',
            document.getElementById('sepiaBtn').classList.contains('active'));
        closeAllDropdowns();
    };

    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.toolDropdown') && !e.target.closest('.dropdownArrow')) {
            closeAllDropdowns();
        }
    });

    // Prevent dropdown from closing when clicking inside
    highlightDropdown.onclick = (e) => e.stopPropagation();
    drawDropdown.onclick = (e) => e.stopPropagation();
    shapesDropdown.onclick = (e) => e.stopPropagation();

    // Drawing Tools - Toggle Behavior
    async function setTool(tool) {
        // If same tool clicked again, deactivate
        if (currentTool === tool) {
            currentTool = null;
            annotationMode = false;
            document.querySelectorAll('.annotationLayer').forEach(el => el.classList.remove('active'));
        } else {
            currentTool = tool;
            annotationMode = true;

            // Set color and width based on tool
            if (tool === 'highlight') {
                currentColor = highlightColor;
                currentWidth = highlightWidth;
            } else if (tool === 'pen') {
                currentColor = drawColor;
                currentWidth = drawWidth;
            } else if (tool === 'shape') {
                currentColor = shapeColor;
                currentWidth = shapeWidth;
            }

            // Activate annotation layers (no re-inject needed, layers persist)
            document.querySelectorAll('.annotationLayer').forEach(layer => {
                layer.classList.add('active');
            });
        }

        // Update button states
        highlightWrapper.classList.toggle('active', currentTool === 'highlight');
        drawWrapper.classList.toggle('active', currentTool === 'pen');
        shapesWrapper.classList.toggle('active', currentTool === 'shape');
        document.getElementById('eraserBtn').classList.toggle('active', currentTool === 'eraser');
        document.getElementById('textBtn').classList.toggle('active', currentTool === 'text');
        document.getElementById('selectBtn').classList.toggle('active', currentTool === 'select');

        // Toggle select-mode class on annotation layers
        document.querySelectorAll('.annotationLayer').forEach(layer => {
            layer.classList.toggle('select-mode', currentTool === 'select');
        });

        // Clear selection when switching tools
        if (currentTool !== 'select') {
            clearAnnotationSelection();
        }
    }

    document.getElementById('drawBtn').onclick = () => setTool('pen');
    document.getElementById('highlightBtn').onclick = () => setTool('highlight');
    document.getElementById('shapesBtn').onclick = () => setTool('shape');
    document.getElementById('eraserBtn').onclick = () => setTool('eraser');
    document.getElementById('textBtn').onclick = () => setTool('text');
    document.getElementById('selectBtn').onclick = () => setTool('select');

    // Undo / Redo / Clear All
    document.getElementById('undoBtn').onclick = () => performUndo();
    document.getElementById('redoBtn').onclick = () => performRedo();
    document.getElementById('clearAllBtn').onclick = () => performClearAll();

    // Color picker event delegation
    function setupColorPicker(containerId, onColorChange) {
        document.getElementById(containerId).addEventListener('click', (e) => {
            const dot = e.target.closest('.colorDot');
            if (!dot) return;
            e.stopPropagation();
            e.currentTarget.querySelectorAll('.colorDot').forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
            onColorChange(dot.dataset.color);
        });
    }
    setupColorPicker('highlightColors', c => {
        highlightColor = c;
        if (currentTool === 'highlight') currentColor = c;
        document.getElementById('highlightWave').setAttribute('stroke', c);
    });
    setupColorPicker('drawColors', c => {
        drawColor = c;
        if (currentTool === 'pen') currentColor = c;
        document.getElementById('drawWave').setAttribute('stroke', c);
    });
    setupColorPicker('shapeColors', c => {
        shapeColor = c;
        if (currentTool === 'shape') currentColor = c;
    });

    // Highlighter Thickness Slider
    document.getElementById('highlightThickness').oninput = (e) => {
        highlightWidth = parseInt(e.target.value);
        if (currentTool === 'highlight') currentWidth = highlightWidth;
        document.getElementById('highlightWave').setAttribute('stroke-width', highlightWidth * 2);
    };

    // Pen Thickness Slider
    document.getElementById('drawThickness').oninput = (e) => {
        drawWidth = parseInt(e.target.value);
        if (currentTool === 'pen') currentWidth = drawWidth;
        document.getElementById('drawWave').setAttribute('stroke-width', drawWidth);
    };

    // Shape Selection (event delegation)
    document.querySelector('.shapeBtn')?.closest('.dropdownSection')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.shapeBtn');
        if (!btn) return;
        e.stopPropagation();
        document.querySelectorAll('.shapeBtn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentShape = btn.dataset.shape;
    });

    // Shape Thickness Slider
    document.getElementById('shapeThickness').oninput = (e) => {
        shapeWidth = parseInt(e.target.value);
        if (currentTool === 'shape') currentWidth = shapeWidth;
    };

    // Annotation Layer with Persistence
    async function injectAnnotationLayer(pageNum) {
        const pageView = pdfViewer.getPageView(pageNum - 1);
        if (!pageView?.div) return;

        // Remove old SVG and abort its event listeners
        const oldSvg = pageView.div.querySelector('.annotationLayer');
        if (oldSvg) oldSvg.remove();
        const oldController = annotationAbortControllers.get(pageNum);
        if (oldController) oldController.abort();

        // Get or calculate base dimensions (scale=1.0, current rotation)
        const currentRotation = pdfViewer.pagesRotation || 0;
        let baseDims = pageBaseDimensions.get(pageNum);
        if (!baseDims) {
            const page = await pdfDoc.getPage(pageNum);
            const baseViewport = page.getViewport({ scale: 1.0, rotation: currentRotation });
            baseDims = { width: baseViewport.width, height: baseViewport.height };
            pageBaseDimensions.set(pageNum, baseDims);
        }

        // Create fresh SVG with viewBox matching rotated dimensions
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'annotationLayer');
        svg.setAttribute('viewBox', `0 0 ${baseDims.width} ${baseDims.height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.dataset.page = pageNum;
        svg.dataset.viewboxWidth = baseDims.width;
        svg.dataset.viewboxHeight = baseDims.height;

        pageView.div.appendChild(svg);



        // Restore saved annotations for this page (with rotation transform if needed)
        if (annotationsStore.has(pageNum)) {
            const savedRot = annotationRotations.get(pageNum) || 0;
            const curRot = pdfViewer.pagesRotation || 0;
            const delta = (curRot - savedRot + 360) % 360;

            if (delta === 0) {
                svg.innerHTML = annotationsStore.get(pageNum);
            } else {
                // Get unrotated page dimensions for transform calculation
                const page = await pdfDoc.getPage(pageNum);
                const unrotVP = page.getViewport({ scale: 1.0 });
                const W = unrotVP.width, H = unrotVP.height;

                // Old viewBox dimensions (at saved rotation)
                let oW, oH;
                if (savedRot === 90 || savedRot === 270) { oW = H; oH = W; }
                else { oW = W; oH = H; }

                let transform;
                if (delta === 90) transform = `translate(${oH},0) rotate(90)`;
                else if (delta === 180) transform = `translate(${oW},${oH}) rotate(180)`;
                else if (delta === 270) transform = `translate(0,${oW}) rotate(270)`;

                svg.innerHTML = `<g transform="${transform}">${annotationsStore.get(pageNum)}</g>`;

                // Update stored annotations & rotation to current
                annotationsStore.set(pageNum, svg.innerHTML);
                annotationRotations.set(pageNum, curRot);
                // Undo/redo stack entries store their own rotation,
                // so no wrapping needed — transforms applied at restore time
            }
        }

        // Bug fix: Use AbortController for cleanup when page re-renders
        const controller = new AbortController();
        const signal = controller.signal;
        annotationAbortControllers.set(pageNum, controller);

        svg.addEventListener('mousedown', (e) => startDraw(e, pageNum), { signal });
        svg.addEventListener('mousemove', draw, { signal });
        svg.addEventListener('mouseup', () => stopDraw(pageNum), { signal });
        svg.addEventListener('mouseleave', () => stopDraw(pageNum), { signal });

        // Touch support for tablets — passive:false only when annotation tool active
        const touchStartHandler = (e) => {
            if (!currentTool) return;
            e.preventDefault();
            startDraw(e, pageNum);
        };
        const touchMoveHandler = (e) => {
            if (!currentTool) return;
            e.preventDefault();
            draw(e);
        };
        if (annotationMode) {
            svg.addEventListener('touchstart', touchStartHandler, { passive: false, signal });
            svg.addEventListener('touchmove', touchMoveHandler, { passive: false, signal });
        } else {
            svg.addEventListener('touchstart', touchStartHandler, { signal });
            svg.addEventListener('touchmove', touchMoveHandler, { signal });
        }
        svg.addEventListener('touchend', () => stopDraw(pageNum), { signal });
        svg.addEventListener('touchcancel', () => stopDraw(pageNum), { signal });

        svg.classList.toggle('active', annotationMode);
    }

    // Strip transient classes, styles, and elements from SVG before saving
    // Works on a clone to avoid modifying live DOM
    function getCleanSvgInnerHTML(svg) {
        const clone = svg.cloneNode(true);
        const marquee = clone.querySelector('.marquee-rect');
        if (marquee) marquee.remove();

        const transientClasses = ['annotation-selected', 'annotation-multi-selected', 'annotation-dragging', 'just-selected'];
        clone.querySelectorAll('path, rect, ellipse, line, text').forEach(el => {
            transientClasses.forEach(cls => el.classList.remove(cls));
            el.removeAttribute('style');
            if (el.getAttribute('class') === '') el.removeAttribute('class');
        });

        return clone.innerHTML.trim();
    }

    // Save annotations for a page (with undo history)
    function saveAnnotations(pageNum) {
        const pageView = pdfViewer.getPageView(pageNum - 1);
        const svg = pageView?.div?.querySelector('.annotationLayer');
        if (!svg) return;

        // Push previous state to undo stack before saving new state
        const previousRotation = annotationRotations.get(pageNum) || 0;
        const newState = getCleanSvgInnerHTML(svg);
        const previousState = annotationsStore.get(pageNum) || '';

        // Only push to history if state actually changed
        if (previousState !== newState) {
            if (!undoStacks.has(pageNum)) undoStacks.set(pageNum, []);
            const stack = undoStacks.get(pageNum);
            // Clone previous SVG children for efficient undo
            const prevNodes = [];
            // Parse previous state to get nodes (use a temp container)
            if (previousState) {
                const temp = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                temp.innerHTML = previousState;
                for (const child of temp.children) prevNodes.push(child.cloneNode(true));
            }
            stack.push({ nodes: prevNodes, rotation: previousRotation });
            if (stack.length > MAX_HISTORY) stack.shift();

            // Clear redo stack on new action
            redoStacks.delete(pageNum);
        }

        if (newState) {
            annotationsStore.set(pageNum, newState);
            annotationRotations.set(pageNum, pdfViewer.pagesRotation || 0);
        } else {
            annotationsStore.delete(pageNum);
            annotationRotations.delete(pageNum);
        }

        updateUndoRedoButtons();
    }

    function updateUndoRedoButtons() {
        const pageNum = pdfViewer ? pdfViewer.currentPageNumber : 0;
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        const undoStack = undoStacks.get(pageNum);
        const redoStack = redoStacks.get(pageNum);
        undoBtn.disabled = !undoStack || undoStack.length === 0;
        redoBtn.disabled = !redoStack || redoStack.length === 0;
    }

    // Helper: clone SVG children into an array of nodes
    function cloneSvgChildren(svg) {
        return Array.from(svg.children).map(c => c.cloneNode(true));
    }

    // Helper: restore SVG from cloned nodes
    function restoreSvgFromNodes(svg, nodes) {
        svg.innerHTML = '';
        nodes.forEach(n => svg.appendChild(n.cloneNode(true)));
    }

    function performUndo() {
        const pageNum = pdfViewer.currentPageNumber;
        const stack = undoStacks.get(pageNum);
        if (!stack || stack.length === 0) return;

        const pageView = pdfViewer.getPageView(pageNum - 1);
        const svg = pageView?.div?.querySelector('.annotationLayer');
        if (!svg) return;

        // Save current state to redo stack
        if (!redoStacks.has(pageNum)) redoStacks.set(pageNum, []);
        const redoStack = redoStacks.get(pageNum);
        redoStack.push({ nodes: cloneSvgChildren(svg), rotation: pdfViewer.pagesRotation || 0 });
        if (redoStack.length > MAX_HISTORY) redoStack.shift();

        // Restore previous state
        const entry = stack.pop();
        restoreSvgFromNodes(svg, entry.nodes);

        // Update store
        const restored = svg.innerHTML.trim();
        if (restored) {
            annotationsStore.set(pageNum, restored);
            annotationRotations.set(pageNum, entry.rotation);
        } else {
            annotationsStore.delete(pageNum);
            annotationRotations.delete(pageNum);
        }

        clearAnnotationSelection();
        updateUndoRedoButtons();
    }

    function performRedo() {
        const pageNum = pdfViewer.currentPageNumber;
        const stack = redoStacks.get(pageNum);
        if (!stack || stack.length === 0) return;

        const pageView = pdfViewer.getPageView(pageNum - 1);
        const svg = pageView?.div?.querySelector('.annotationLayer');
        if (!svg) return;

        // Save current state to undo stack
        if (!undoStacks.has(pageNum)) undoStacks.set(pageNum, []);
        const undoStack = undoStacks.get(pageNum);
        undoStack.push({ nodes: cloneSvgChildren(svg), rotation: pdfViewer.pagesRotation || 0 });
        if (undoStack.length > MAX_HISTORY) undoStack.shift();

        // Restore redo state
        const entry = stack.pop();
        restoreSvgFromNodes(svg, entry.nodes);

        // Update store
        const restored = svg.innerHTML.trim();
        if (restored) {
            annotationsStore.set(pageNum, restored);
            annotationRotations.set(pageNum, entry.rotation);
        } else {
            annotationsStore.delete(pageNum);
            annotationRotations.delete(pageNum);
        }

        clearAnnotationSelection();
        updateUndoRedoButtons();
    }

    function performClearAll() {
        const pageNum = pdfViewer.currentPageNumber;
        const pageView = pdfViewer.getPageView(pageNum - 1);
        const svg = pageView?.div?.querySelector('.annotationLayer');
        if (!svg || !svg.innerHTML.trim()) return;

        // Save current state to undo stack (so it can be undone)
        if (!undoStacks.has(pageNum)) undoStacks.set(pageNum, []);
        const stack = undoStacks.get(pageNum);
        stack.push({ nodes: cloneSvgChildren(svg), rotation: pdfViewer.pagesRotation || 0 });
        if (stack.length > MAX_HISTORY) stack.shift();

        // Clear redo stack
        redoStacks.delete(pageNum);

        // Clear all annotations
        svg.innerHTML = '';
        annotationsStore.delete(pageNum);
        annotationRotations.delete(pageNum);

        clearAnnotationSelection();
        updateUndoRedoButtons();
    }

    function startDraw(e, pageNum) {
        if (!annotationMode || !currentTool) return;

        e.preventDefault(); // Prevent text selection

        const svg = e.currentTarget;
        if (!svg || !svg.dataset.viewboxWidth) return; // Defensive check

        // Handle select tool separately
        if (currentTool === 'select') {
            if (handleSelectMouseDown(e, svg, pageNum)) {
                return; // Select tool handled the event
            }
        }

        isDrawing = true;
        currentDrawingPage = pageNum;
        currentSvg = svg; // Store reference

        // Convert screen coords to viewBox coords (rotation-aware)
        const coords = getEventCoords(e);
        const vb = screenToViewBox(svg, coords.clientX, coords.clientY);
        const x = vb.x;
        const y = vb.y;
        const scaleX = vb.scaleX;
        const scaleY = vb.scaleY;

        if (currentTool === 'eraser') {
            isDrawing = true;
            currentDrawingPage = pageNum;
            currentSvg = svg;
            eraseAt(svg, x, y, scaleX, coords.clientX, coords.clientY);
            return;
        }

        // Text tool - create/edit/drag text
        if (currentTool === 'text') {
            // Check if clicked on existing text element
            const elementsUnderClick = document.elementsFromPoint(e.clientX, e.clientY);
            const existingText = elementsUnderClick.find(el => el.tagName === 'text' && el.closest('.annotationLayer'));

            if (existingText) {
                // Start dragging (double-click will edit via separate handler)
                startTextDrag(e, existingText, svg, scaleX, pageNum);
            } else {
                // Create new text
                showTextEditor(e.clientX, e.clientY, svg, x, y, scaleX, pageNum);
            }
            return;
        }

        // Shape tool - create shapes
        if (currentTool === 'shape') {
            isDrawing = true;
            // Store start position for shape drawing
            svg.dataset.shapeStartX = x;
            svg.dataset.shapeStartY = y;
            svg.dataset.shapeScaleX = scaleX;
            svg.dataset.shapeScaleY = scaleY;

            let shapeEl;
            if (currentShape === 'rectangle') {
                shapeEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                shapeEl.setAttribute('x', x);
                shapeEl.setAttribute('y', y);
                shapeEl.setAttribute('width', 0);
                shapeEl.setAttribute('height', 0);
            } else if (currentShape === 'circle') {
                shapeEl = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
                shapeEl.setAttribute('cx', x);
                shapeEl.setAttribute('cy', y);
                shapeEl.setAttribute('rx', 0);
                shapeEl.setAttribute('ry', 0);
            } else if (currentShape === 'line' || currentShape === 'arrow') {
                shapeEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                shapeEl.setAttribute('x1', x);
                shapeEl.setAttribute('y1', y);
                shapeEl.setAttribute('x2', x);
                shapeEl.setAttribute('y2', y);
            }

            shapeEl.setAttribute('stroke', currentColor);
            shapeEl.setAttribute('stroke-width', String(currentWidth * scaleX));
            shapeEl.setAttribute('fill', 'none');
            shapeEl.classList.add('current-shape');
            svg.appendChild(shapeEl);
            return;
        }

        currentPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        currentPath.setAttribute('stroke', currentColor);
        currentPath.setAttribute('fill', 'none');

        if (currentTool === 'highlight') {
            // Highlighter uses stroke size * 5 for thicker strokes
            currentPath.setAttribute('stroke-width', String(currentWidth * 5 * scaleX));
            currentPath.setAttribute('stroke-opacity', '0.35');
        } else {
            currentPath.setAttribute('stroke-width', String(currentWidth * scaleX));
            currentPath.setAttribute('stroke-opacity', '1');
        }

        pathSegments = [`M${x.toFixed(2)},${y.toFixed(2)}`];
        currentPath.setAttribute('d', pathSegments[0]);
        svg.appendChild(currentPath);
    }

    function draw(e) {
        if (!isDrawing || !currentSvg) return;

        // Bug fix: Check if SVG is still in DOM (prevents stale reference)
        if (!currentSvg.isConnected) {
            isDrawing = false;
            currentPath = null;
            currentSvg = null;
            currentDrawingPage = null;
            return;
        }

        e.preventDefault(); // Prevent text selection

        const svg = currentSvg; // Use stored reference
        if (!svg || !svg.dataset.viewboxWidth) return;

        // Convert screen coords to viewBox coords (rotation-aware)
        const coords = getEventCoords(e);
        const vb = screenToViewBox(svg, coords.clientX, coords.clientY);
        const x = vb.x;
        const y = vb.y;
        const scaleX = vb.scaleX;

        if (currentTool === 'eraser') {
            eraseAt(svg, x, y, scaleX, coords.clientX, coords.clientY);
            return;
        }

        // Shape tool - update shape size
        if (currentTool === 'shape') {
            const shapeEl = svg.querySelector('.current-shape');
            if (!shapeEl) return;

            const startX = parseFloat(svg.dataset.shapeStartX);
            const startY = parseFloat(svg.dataset.shapeStartY);

            if (currentShape === 'rectangle') {
                const width = Math.abs(x - startX);
                const height = Math.abs(y - startY);
                shapeEl.setAttribute('x', Math.min(x, startX));
                shapeEl.setAttribute('y', Math.min(y, startY));
                shapeEl.setAttribute('width', width);
                shapeEl.setAttribute('height', height);
            } else if (currentShape === 'circle') {
                const rx = Math.abs(x - startX) / 2;
                const ry = Math.abs(y - startY) / 2;
                shapeEl.setAttribute('cx', (startX + x) / 2);
                shapeEl.setAttribute('cy', (startY + y) / 2);
                shapeEl.setAttribute('rx', rx);
                shapeEl.setAttribute('ry', ry);
            } else if (currentShape === 'line' || currentShape === 'arrow' || currentShape === 'callout') {
                shapeEl.setAttribute('x2', x);
                shapeEl.setAttribute('y2', y);
            }
            return;
        }

        if (currentPath) {
            pathSegments.push(`L${x.toFixed(2)},${y.toFixed(2)}`);
            if (!drawRAF) {
                drawRAF = requestAnimationFrame(() => {
                    drawRAF = null;
                    if (currentPath) currentPath.setAttribute('d', pathSegments.join(' '));
                });
            }
        }
    }

    function stopDraw(pageNum) {
        // Handle arrow marker
        if (currentTool === 'shape' && currentShape === 'arrow' && currentSvg) {
            const shapeEl = currentSvg.querySelector('.current-shape');
            if (shapeEl && shapeEl.tagName === 'line') {
                // Create arrow head as a group
                const x1 = parseFloat(shapeEl.getAttribute('x1'));
                const y1 = parseFloat(shapeEl.getAttribute('y1'));
                const x2 = parseFloat(shapeEl.getAttribute('x2'));
                const y2 = parseFloat(shapeEl.getAttribute('y2'));

                // Calculate arrow head
                const angle = Math.atan2(y2 - y1, x2 - x1);
                const headLength = 15 * parseFloat(currentSvg.dataset.shapeScaleX || 1);

                const arrowHead = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                const p1x = x2 - headLength * Math.cos(angle - Math.PI / 6);
                const p1y = y2 - headLength * Math.sin(angle - Math.PI / 6);
                const p2x = x2 - headLength * Math.cos(angle + Math.PI / 6);
                const p2y = y2 - headLength * Math.sin(angle + Math.PI / 6);

                arrowHead.setAttribute('d', `M${x2},${y2} L${p1x},${p1y} M${x2},${y2} L${p2x},${p2y}`);
                arrowHead.setAttribute('stroke', shapeEl.getAttribute('stroke'));
                arrowHead.setAttribute('stroke-width', shapeEl.getAttribute('stroke-width'));
                arrowHead.setAttribute('fill', 'none');
                currentSvg.appendChild(arrowHead);
            }
        }

        // Handle callout - arrow with text at the start, pointing to end
        // UX: Click where you want text box, drag to point at something
        if (currentTool === 'shape' && currentShape === 'callout' && currentSvg) {
            const shapeEl = currentSvg.querySelector('.current-shape');
            if (shapeEl && shapeEl.tagName === 'line') {
                const x1 = parseFloat(shapeEl.getAttribute('x1')); // Start - where text box goes
                const y1 = parseFloat(shapeEl.getAttribute('y1'));
                const x2 = parseFloat(shapeEl.getAttribute('x2')); // End - where arrow points
                const y2 = parseFloat(shapeEl.getAttribute('y2'));

                // Only create callout if line has been drawn (not just a click)
                if (Math.abs(x2 - x1) > 5 || Math.abs(y2 - y1) > 5) {
                    const scaleX = parseFloat(currentSvg.dataset.shapeScaleX || 1);

                    // Arrow head points TO the end (x2,y2) - where user wants to point at
                    const angle = Math.atan2(y2 - y1, x2 - x1);
                    const headLength = 12 * scaleX;

                    const arrowHead = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    const p1x = x2 - headLength * Math.cos(angle - Math.PI / 6);
                    const p1y = y2 - headLength * Math.sin(angle - Math.PI / 6);
                    const p2x = x2 - headLength * Math.cos(angle + Math.PI / 6);
                    const p2y = y2 - headLength * Math.sin(angle + Math.PI / 6);

                    arrowHead.setAttribute('d', `M${x2},${y2} L${p1x},${p1y} M${x2},${y2} L${p2x},${p2y}`);
                    arrowHead.setAttribute('stroke', shapeEl.getAttribute('stroke'));
                    arrowHead.setAttribute('stroke-width', shapeEl.getAttribute('stroke-width'));
                    arrowHead.setAttribute('fill', 'none');
                    arrowHead.classList.add('callout-arrow');
                    currentSvg.appendChild(arrowHead);

                    // Store references for text editor
                    const svg = currentSvg;
                    const currentPageNum = currentDrawingPage;
                    const arrowColor = shapeEl.getAttribute('stroke');

                    // Calculate screen position for text editor at START of arrow (x1,y1)
                    // This is where the user clicked first - where they want the text
                    const rect = svg.getBoundingClientRect();
                    const viewBoxWidth = parseFloat(svg.dataset.viewboxWidth);
                    const viewBoxHeight = parseFloat(svg.dataset.viewboxHeight);
                    const screenX = rect.left + (x1 / viewBoxWidth) * rect.width;
                    const screenY = rect.top + (y1 / viewBoxHeight) * rect.height;

                    // Remove the current-shape class before showing editor
                    shapeEl.classList.remove('current-shape');

                    // Save first, then open text editor
                    saveAnnotations(currentPageNum);

                    // Open text editor at the START of the arrow (where user clicked)
                    setTimeout(() => {
                        showTextEditor(screenX, screenY, svg, x1, y1, scaleX, currentPageNum, null, arrowColor);
                    }, 50);

                    // Reset state
                    isDrawing = false;
                    currentPath = null;
                    currentSvg = null;
                    currentDrawingPage = null;
                    return; // Exit early, text editor will handle the rest
                }
            }
        }

        // Remove the current-shape class
        if (currentSvg) {
            const shapeEl = currentSvg.querySelector('.current-shape');
            if (shapeEl) shapeEl.classList.remove('current-shape');
        }

        // Flush pending path segments
        if (currentPath && pathSegments.length > 0) {
            currentPath.setAttribute('d', pathSegments.join(' '));
        }
        pathSegments = [];
        if (drawRAF) { cancelAnimationFrame(drawRAF); drawRAF = null; }

        if (isDrawing && currentDrawingPage) {
            saveAnnotations(currentDrawingPage);
        }
        isDrawing = false;
        currentPath = null;
        currentSvg = null;
        currentDrawingPage = null;
    }

    // Text Drag-and-Drop
    let draggedText = null;
    let dragStartX = 0;
    let dragStartY = 0;
    let textOriginalX = 0;
    let textOriginalY = 0;
    let hasDragged = false;

    function startTextDrag(e, textEl, svg, scaleX, pageNum) {
        e.preventDefault();
        e.stopPropagation();

        draggedText = textEl;
        textEl.classList.add('dragging');
        hasDragged = false;

        dragStartX = e.clientX;
        dragStartY = e.clientY;
        textOriginalX = parseFloat(textEl.getAttribute('x'));
        textOriginalY = parseFloat(textEl.getAttribute('y'));

        function onMouseMove(ev) {
            const dxScreen = ev.clientX - dragStartX;
            const dyScreen = ev.clientY - dragStartY;
            // Convert screen delta to viewBox delta (rotation-aware)
            const vbDelta = screenDeltaToViewBox(svg, dxScreen, dyScreen, textEl);

            if (Math.abs(vbDelta.dx) > 2 || Math.abs(vbDelta.dy) > 2) {
                hasDragged = true;
            }

            textEl.setAttribute('x', (textOriginalX + vbDelta.dx).toFixed(2));
            textEl.setAttribute('y', (textOriginalY + vbDelta.dy).toFixed(2));
        }

        function onMouseUp(ev) {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            textEl.classList.remove('dragging');

            if (hasDragged) {
                // Moved - save position
                saveAnnotations(pageNum);
            } else {
                // Not moved - short click = edit
                const viewBoxWidth = parseFloat(svg.dataset.viewboxWidth);
                const viewBoxHeight = parseFloat(svg.dataset.viewboxHeight);
                const svgX = parseFloat(textEl.getAttribute('x'));
                const svgY = parseFloat(textEl.getAttribute('y'));
                // Note: showTextEditor needs scaleX for font scaling logic, which we still have from arguments
                showTextEditor(ev.clientX, ev.clientY, svg, svgX, svgY, scaleX, pageNum, textEl);
            }

            draggedText = null;
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    // Inline Text Editor
    let textFontSize = 20;

    function showTextEditor(screenX, screenY, svg, svgX, svgY, scale, pageNum, existingTextEl = null, overrideColor = null) {
        // Remove existing editor if any
        const existingOverlay = document.querySelector('.textEditorOverlay');
        if (existingOverlay) existingOverlay.remove();

        // Use override color (for callout) or current color
        let textColor = overrideColor || currentColor;

        // If editing existing text, get its properties
        let editingText = null;
        if (existingTextEl && typeof existingTextEl === 'object' && existingTextEl.textContent !== undefined) {
            editingText = existingTextEl.textContent;
            textFontSize = parseFloat(existingTextEl.getAttribute('font-size')) / scale || 20;
            // Use existing text's color
            textColor = existingTextEl.getAttribute('fill') || textColor;
        }

        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'textEditorOverlay';

        // Create editor box
        const box = document.createElement('div');
        box.className = 'textEditorBox';
        box.style.left = screenX + 'px';
        box.style.top = screenY + 'px';

        // Input area
        const input = document.createElement('div');
        input.className = 'textEditorInput';
        input.contentEditable = true;
        input.style.color = textColor;
        input.style.fontSize = textFontSize + 'px';
        if (editingText) {
            input.textContent = editingText;
        }

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'textEditorToolbar';

        // Color palette
        const colorsDiv = document.createElement('div');
        colorsDiv.className = 'textEditorColors';
        const textEditorColors = ['#000000', '#e81224', '#0078d4', '#16c60c', '#fff100', '#886ce4', '#ff8c00', '#ffffff'];
        let activeColor = textColor;

        textEditorColors.forEach(c => {
            const dot = document.createElement('div');
            dot.className = 'textEditorColorDot' + (c === activeColor ? ' active' : '');
            dot.style.background = c;
            if (c === '#ffffff') dot.style.border = '2px solid #ccc';
            dot.onclick = (e) => {
                e.stopPropagation();
                activeColor = c;
                input.style.color = c;
                colorsDiv.querySelectorAll('.textEditorColorDot').forEach(d => d.classList.remove('active'));
                dot.classList.add('active');
            };
            colorsDiv.appendChild(dot);
        });

        // Font size group: A⁻ [size] A⁺
        const sizeGroup = document.createElement('div');
        sizeGroup.className = 'textEditorSizeGroup';

        const sizeLabel = document.createElement('span');
        sizeLabel.className = 'textEditorSizeLabel';
        sizeLabel.textContent = textFontSize;

        const decreaseBtn = document.createElement('button');
        decreaseBtn.className = 'textEditorBtn';
        decreaseBtn.innerHTML = 'A<sup>-</sup>';
        decreaseBtn.onclick = (e) => {
            e.stopPropagation();
            if (textFontSize > 10) {
                textFontSize -= 2;
                input.style.fontSize = textFontSize + 'px';
                sizeLabel.textContent = textFontSize;
            }
        };

        const increaseBtn = document.createElement('button');
        increaseBtn.className = 'textEditorBtn';
        increaseBtn.innerHTML = 'A<sup>+</sup>';
        increaseBtn.onclick = (e) => {
            e.stopPropagation();
            if (textFontSize < 60) {
                textFontSize += 2;
                input.style.fontSize = textFontSize + 'px';
                sizeLabel.textContent = textFontSize;
            }
        };

        sizeGroup.appendChild(decreaseBtn);
        sizeGroup.appendChild(sizeLabel);
        sizeGroup.appendChild(increaseBtn);

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'textEditorBtn delete';
        deleteBtn.innerHTML = '🗑️';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            if (existingTextEl) {
                existingTextEl.remove();
                saveAnnotations(pageNum);
            }
            overlay.remove();
        };

        toolbar.appendChild(colorsDiv);
        toolbar.appendChild(sizeGroup);
        toolbar.appendChild(deleteBtn);

        box.appendChild(input);
        box.appendChild(toolbar);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        // Focus input and select all if editing
        setTimeout(() => {
            input.focus();
            if (editingText) {
                const range = document.createRange();
                range.selectNodeContents(input);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }, 50);

        // Confirm on click outside or Enter
        function confirmText() {
            const text = input.textContent.trim();
            if (text) {
                if (existingTextEl) {
                    // Update existing text element
                    existingTextEl.textContent = text;
                    existingTextEl.setAttribute('fill', activeColor);
                    existingTextEl.setAttribute('font-size', String(textFontSize * scale));
                } else {
                    // Create new text element
                    const textEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                    textEl.setAttribute('x', svgX.toFixed(2));
                    textEl.setAttribute('y', svgY.toFixed(2));
                    textEl.setAttribute('fill', activeColor);
                    textEl.setAttribute('font-size', String(textFontSize * scale));
                    textEl.setAttribute('font-family', 'Segoe UI, Arial, sans-serif');
                    textEl.textContent = text;
                    svg.appendChild(textEl);
                }
                saveAnnotations(pageNum);
            } else if (existingTextEl) {
                // Empty text = delete existing
                existingTextEl.remove();
                saveAnnotations(pageNum);
            }
            overlay.remove();
        }

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) confirmText();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                confirmText();
            }
            if (e.key === 'Escape') {
                overlay.remove();
            }
        });
    }

    function eraseAt(svg, x, y, scale = 1, clientX, clientY) {
        // Use browser-optimized hit-test for SVG annotation elements
        const annotationTags = new Set(['path', 'rect', 'ellipse', 'line', 'text']);
        const elements = document.elementsFromPoint(clientX, clientY);
        elements.forEach(el => {
            if (el.closest('.annotationLayer') === svg && annotationTags.has(el.tagName)) {
                el.remove();
            }
        });

        // Also erase text highlights (in separate container)
        const pageDiv = svg.closest('.page');
        if (pageDiv) {
            const highlightContainer = pageDiv.querySelector('.textHighlightContainer');
            if (highlightContainer) {
                const vbW = parseFloat(svg.dataset.viewboxWidth);
                const vbH = parseFloat(svg.dataset.viewboxHeight);
                const screenXPercent = (x / vbW) * 100;
                const screenYPercent = (y / vbH) * 100;

                highlightContainer.querySelectorAll('.textHighlight').forEach(el => {
                    const left = parseFloat(el.style.left);
                    const top = parseFloat(el.style.top);
                    const width = parseFloat(el.style.width);
                    const height = parseFloat(el.style.height);

                    if (screenXPercent >= left - 2 && screenXPercent <= left + width + 2 &&
                        screenYPercent >= top - 2 && screenYPercent <= top + height + 2) {
                        el.remove();
                        const pageNum = parseInt(pageDiv.dataset.pageNumber);
                        saveTextHighlights(pageNum, pageDiv);
                    }
                });
            }
        }
    }

    // ==========================================
    // TEXT SELECTION HIGHLIGHTING (Adobe/Edge style)
    // ==========================================
    let highlightPopup = null;

    function removeHighlightPopup() {
        if (highlightPopup) {
            highlightPopup.remove();
            highlightPopup = null;
        }
    }

    function getSelectionRects() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return null;

        const range = selection.getRangeAt(0);
        const rects = range.getClientRects();
        if (rects.length === 0) return null;

        // Find which page the selection is in
        const startNode = range.startContainer.parentElement;
        const textLayer = startNode?.closest('.textLayer');
        if (!textLayer) return null;

        const pageDiv = textLayer.closest('.page');
        if (!pageDiv) return null;

        const pageNum = parseInt(pageDiv.dataset.pageNumber);
        const pageRect = pageDiv.getBoundingClientRect();

        // Convert rects to page-relative coordinates
        const relativeRects = [];
        for (let i = 0; i < rects.length; i++) {
            const rect = rects[i];
            relativeRects.push({
                x: rect.left - pageRect.left,
                y: rect.top - pageRect.top,
                width: rect.width,
                height: rect.height
            });
        }

        return { pageNum, pageDiv, relativeRects, lastRect: rects[rects.length - 1] };
    }

    function createTextHighlights(pageDiv, rects, color) {
        // Find or create highlight container
        let highlightContainer = pageDiv.querySelector('.textHighlightContainer');
        if (!highlightContainer) {
            highlightContainer = document.createElement('div');
            highlightContainer.className = 'textHighlightContainer';
            highlightContainer.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:5;';
            pageDiv.insertBefore(highlightContainer, pageDiv.firstChild);
        }

        // Get page dimensions for percentage calculation
        const pageRect = pageDiv.getBoundingClientRect();
        const pageWidth = pageRect.width;
        const pageHeight = pageRect.height;

        // Add highlight rectangles with percentage positioning
        rects.forEach(rect => {
            const div = document.createElement('div');
            div.className = 'textHighlight';

            // Convert to percentages for zoom-independent positioning
            const leftPercent = (rect.x / pageWidth) * 100;
            const topPercent = (rect.y / pageHeight) * 100;
            const widthPercent = (rect.width / pageWidth) * 100;
            const heightPercent = (rect.height / pageHeight) * 100;

            div.style.cssText = `
            left: ${leftPercent}%;
            top: ${topPercent}%;
            width: ${widthPercent}%;
            height: ${heightPercent}%;
            background: ${color};
            opacity: 0.35;
        `;
            highlightContainer.appendChild(div);
        });

        // Save to annotations store
        const pageNum = parseInt(pageDiv.dataset.pageNumber);
        saveTextHighlights(pageNum, pageDiv);
    }

    function saveTextHighlights(pageNum, pageDiv) {
        const container = pageDiv.querySelector('.textHighlightContainer');
        if (container) {
            const key = `textHighlight_${pageNum}`;
            localStorage.setItem(key, container.innerHTML);
        }
    }

    function loadTextHighlights(pageNum, pageDiv) {
        const key = `textHighlight_${pageNum}`;
        const saved = localStorage.getItem(key);
        if (saved) {
            let container = pageDiv.querySelector('.textHighlightContainer');
            if (!container) {
                container = document.createElement('div');
                container.className = 'textHighlightContainer';
                container.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:5;';
                pageDiv.insertBefore(container, pageDiv.firstChild);
            }
            container.innerHTML = saved;
        }
    }

    function showHighlightPopup(x, y, pageDiv, rects) {
        removeHighlightPopup();

        highlightPopup = document.createElement('div');
        highlightPopup.className = 'highlightPopup';
        highlightPopup.style.left = x + 'px';
        highlightPopup.style.top = (y + 10) + 'px';

        const colors = ['#fff100', '#16c60c', '#00b7c3', '#0078d4', '#886ce4', '#e81224'];
        colors.forEach(color => {
            const btn = document.createElement('button');
            btn.style.background = color;
            btn.title = 'Vurgula';
            btn.onclick = (e) => {
                e.stopPropagation();
                createTextHighlights(pageDiv, rects, color);
                window.getSelection().removeAllRanges();
                removeHighlightPopup();
            };
            highlightPopup.appendChild(btn);
        });

        document.body.appendChild(highlightPopup);
    }

    // Listen for text selection
    document.addEventListener('mouseup', (e) => {
        // Small delay to let selection finalize
        setTimeout(() => {
            const selData = getSelectionRects();
            if (selData && selData.relativeRects.length > 0) {
                const lastRect = selData.lastRect;
                showHighlightPopup(lastRect.right, lastRect.bottom, selData.pageDiv, selData.relativeRects);
            } else {
                removeHighlightPopup();
            }
        }, 10);
    });

    // Remove popup on click elsewhere
    document.addEventListener('mousedown', (e) => {
        if (highlightPopup && !highlightPopup.contains(e.target)) {
            removeHighlightPopup();
        }
    });

    // Load text highlights when pages render
    eventBus.on('pagerendered', (evt) => {
        const pageDiv = pdfViewer.getPageView(evt.pageNumber - 1)?.div;
        if (pageDiv) {
            loadTextHighlights(evt.pageNumber, pageDiv);
        }
    });

    // ==========================================
    // SELECT/MOVE TOOL (Fixed + Touch Support)
    // ==========================================
    let selectedAnnotation = null;
    let selectedSvg = null;
    let selectedPageNum = null;
    let copiedAnnotation = null;
    let copiedPageNum = null;
    let isDraggingAnnotation = false;
    let annotationDragStartX = 0;
    let annotationDragStartY = 0;

    // Marquee selection state
    let marqueeActive = false;
    let marqueeStartX = 0, marqueeStartY = 0;
    let marqueeRect = null;
    let marqueeSvg = null;
    let marqueePageNum = null;
    let multiSelectedAnnotations = [];

    // Create selection toolbar for touch devices
    const selectionToolbar = document.createElement('div');
    selectionToolbar.className = 'selection-toolbar';
    selectionToolbar.innerHTML = `
    <button data-action="copy" title="Kopyala (Ctrl+C)">
        <svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
        <span>Kopyala</span>
    </button>
    <button data-action="duplicate" title="Çoğalt">
        <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>
        <span>Çoğalt</span>
    </button>
    <button data-action="delete" class="delete" title="Sil (Del)">
        <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        <span>Sil</span>
    </button>
`;
    document.body.appendChild(selectionToolbar);

    // Selection toolbar event handlers
    selectionToolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;

        const action = btn.dataset.action;
        if (action === 'copy') {
            copySelectedAnnotation();
            showToast('Kopyalandı!');
        } else if (action === 'duplicate') {
            copySelectedAnnotation();
            pasteAnnotation();
            showToast('Çoğaltıldı!');
        } else if (action === 'delete') {
            deleteSelectedAnnotation();
            showToast('Silindi!');
        }
    });

    function showToast(message) {
        const existingToast = document.querySelector('.toast-notification');
        if (existingToast) existingToast.remove();

        const toast = document.createElement('div');
        toast.className = 'toast-notification';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }

    function updateSelectionToolbar() {
        if (selectedAnnotation && currentTool === 'select') {
            selectionToolbar.classList.add('visible');
        } else {
            selectionToolbar.classList.remove('visible');
        }
    }

    function clearMultiSelection() {
        if (multiDragHandler) {
            multiSelectedAnnotations.forEach(el => {
                el.removeEventListener('mousedown', multiDragHandler);
                el.removeEventListener('touchstart', multiDragHandler);
            });
            multiDragHandler = null;
        }
        multiSelectedAnnotations.forEach(el => {
            el.classList.remove('annotation-multi-selected');
            el.style.cursor = '';
        });
        multiSelectedAnnotations = [];
    }

    function clearAnnotationSelection() {
        if (selectedAnnotation) {
            selectedAnnotation.classList.remove('annotation-selected', 'annotation-dragging', 'just-selected');
        }
        selectedAnnotation = null;
        selectedSvg = null;
        selectedPageNum = null;
        isDraggingAnnotation = false;
        clearMultiSelection();
        updateSelectionToolbar();
    }

    function selectAnnotation(element, svg, pageNum) {
        clearAnnotationSelection();
        selectedAnnotation = element;
        selectedSvg = svg;
        selectedPageNum = pageNum;
        element.classList.add('annotation-selected', 'just-selected');

        // Remove pulse animation after it completes
        setTimeout(() => {
            element.classList.remove('just-selected');
        }, 600);

        updateSelectionToolbar();
    }

    function deleteSelectedAnnotation() {
        if (multiSelectedAnnotations.length > 0 && marqueeSvg) {
            // Delete all multi-selected annotations
            const pageNum = marqueePageNum;
            multiSelectedAnnotations.forEach(el => el.remove());
            clearMultiSelection();
            if (marqueeSvg && marqueeSvg.isConnected) saveAnnotations(pageNum);
            marqueeSvg = null;
            marqueePageNum = null;
        } else if (selectedAnnotation && selectedSvg) {
            selectedAnnotation.remove();
            saveAnnotations(selectedPageNum);
            clearAnnotationSelection();
        }
    }

    function copySelectedAnnotation() {
        if (selectedAnnotation) {
            copiedAnnotation = selectedAnnotation.cloneNode(true);
            copiedAnnotation.classList.remove('annotation-selected', 'annotation-dragging', 'just-selected');
            copiedPageNum = selectedPageNum;
        }
    }

    function pasteAnnotation() {
        if (!copiedAnnotation || !pdfViewer) return;

        // Paste to current page
        const currentPage = pdfViewer.currentPageNumber;
        const pageView = pdfViewer.getPageView(currentPage - 1);
        const svg = pageView?.div?.querySelector('.annotationLayer');

        if (svg) {
            const cloned = copiedAnnotation.cloneNode(true);
            const offset = 30; // Offset amount for pasted elements

            // Offset pasted element slightly
            if (cloned.tagName === 'path') {
                // For paths, add/update transform translate
                const currentTransform = cloned.getAttribute('transform') || '';
                const match = currentTransform.match(/translate\(([^,]+),([^)]+)\)/);
                let tx = offset, ty = offset;
                if (match) {
                    tx = parseFloat(match[1]) + offset;
                    ty = parseFloat(match[2]) + offset;
                }
                cloned.setAttribute('transform', `translate(${tx}, ${ty})`);
            } else if (cloned.tagName === 'rect') {
                cloned.setAttribute('x', parseFloat(cloned.getAttribute('x')) + offset);
                cloned.setAttribute('y', parseFloat(cloned.getAttribute('y')) + offset);
            } else if (cloned.tagName === 'ellipse') {
                cloned.setAttribute('cx', parseFloat(cloned.getAttribute('cx')) + offset);
                cloned.setAttribute('cy', parseFloat(cloned.getAttribute('cy')) + offset);
            } else if (cloned.tagName === 'line') {
                cloned.setAttribute('x1', parseFloat(cloned.getAttribute('x1')) + offset);
                cloned.setAttribute('y1', parseFloat(cloned.getAttribute('y1')) + offset);
                cloned.setAttribute('x2', parseFloat(cloned.getAttribute('x2')) + offset);
                cloned.setAttribute('y2', parseFloat(cloned.getAttribute('y2')) + offset);
            } else if (cloned.tagName === 'text') {
                cloned.setAttribute('x', parseFloat(cloned.getAttribute('x')) + offset);
                cloned.setAttribute('y', parseFloat(cloned.getAttribute('y')) + offset);
            }

            svg.appendChild(cloned);
            saveAnnotations(currentPage);
            selectAnnotation(cloned, svg, currentPage);
        }
    }

    // Get coordinates from mouse or touch event
    function getEventCoords(e) {
        if (e.touches && e.touches.length > 0) {
            return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
        }
        if (e.changedTouches && e.changedTouches.length > 0) {
            return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
        }
        return { clientX: e.clientX, clientY: e.clientY };
    }

    // Convert screen coordinates to viewBox coordinates, accounting for CSS rotation
    function screenToViewBox(svg, clientX, clientY) {
        const rect = svg.getBoundingClientRect();
        const vbW = parseFloat(svg.dataset.viewboxWidth);
        const vbH = parseFloat(svg.dataset.viewboxHeight);

        // Offset from center in screen pixels
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const udx = clientX - cx;
        const udy = clientY - cy;

        // Element dimensions (no CSS rotation — PDF.js handles rotation natively)
        let elemW, elemH;
        {
            elemW = rect.width;
            elemH = rect.height;
        }

        // Map to viewBox: center-relative to 0,0-relative
        const x = (udx + elemW / 2) * (vbW / elemW);
        const y = (udy + elemH / 2) * (vbH / elemH);

        const scaleX = vbW / elemW;
        const scaleY = vbH / elemH;

        return { x, y, scaleX, scaleY };
    }

    // Convert screen delta (dx,dy pixels) to viewBox delta
    // If element is inside a rotated <g>, counter-rotate the delta
    function screenDeltaToViewBox(svg, dxScreen, dyScreen, element) {
        const rect = svg.getBoundingClientRect();
        const vbW = parseFloat(svg.dataset.viewboxWidth);
        const vbH = parseFloat(svg.dataset.viewboxHeight);

        let dx = dxScreen * (vbW / rect.width);
        let dy = dyScreen * (vbH / rect.height);

        // Check if element is inside a rotated <g> wrapper
        if (element) {
            const parentG = element.parentElement;
            if (parentG && parentG.tagName === 'g' && parentG.getAttribute('transform')) {
                const t = parentG.getAttribute('transform');
                const rotMatch = t.match(/rotate\((\d+)\)/);
                if (rotMatch) {
                    const rot = parseInt(rotMatch[1]);
                    // Counter-rotate the delta to match <g>'s local coordinate system
                    if (rot === 90) { const tmp = dx; dx = dy; dy = -tmp; }
                    else if (rot === 180) { dx = -dx; dy = -dy; }
                    else if (rot === 270) { const tmp = dx; dx = -dy; dy = tmp; }
                }
            }
        }

        return { dx, dy };
    }

    // Handle select tool events (both mouse and touch)
    function handleSelectPointerDown(e, svg, pageNum) {
        if (currentTool !== 'select') return false;

        const coords = getEventCoords(e);
        const target = e.target;

        if (target === svg || target.tagName === 'svg') {
            // Clicked on empty area — clear selections and start marquee
            clearAnnotationSelection();

            const pt = screenToViewBox(svg, coords.clientX, coords.clientY);

            marqueeActive = true;
            marqueeStartX = pt.x;
            marqueeStartY = pt.y;
            marqueeSvg = svg;
            marqueePageNum = pageNum;

            // Create marquee rectangle
            marqueeRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            marqueeRect.setAttribute('class', 'marquee-rect');
            marqueeRect.setAttribute('x', pt.x);
            marqueeRect.setAttribute('y', pt.y);
            marqueeRect.setAttribute('width', 0);
            marqueeRect.setAttribute('height', 0);
            svg.appendChild(marqueeRect);

            let marqueeRAF = null;
            function onMarqueeMove(ev) {
                if (!marqueeActive || !marqueeRect) return;
                ev.preventDefault();

                const moveCoords = getEventCoords(ev);
                const mpt = screenToViewBox(marqueeSvg, moveCoords.clientX, moveCoords.clientY);

                if (!marqueeRAF) {
                    marqueeRAF = requestAnimationFrame(() => {
                        marqueeRAF = null;
                        if (!marqueeRect) return;
                        const x = Math.min(marqueeStartX, mpt.x);
                        const y = Math.min(marqueeStartY, mpt.y);
                        const w = Math.abs(mpt.x - marqueeStartX);
                        const h = Math.abs(mpt.y - marqueeStartY);

                        marqueeRect.setAttribute('x', x);
                        marqueeRect.setAttribute('y', y);
                        marqueeRect.setAttribute('width', w);
                        marqueeRect.setAttribute('height', h);
                    });
                }
            }

            function onMarqueeEnd(ev) {
                document.removeEventListener('mousemove', onMarqueeMove);
                document.removeEventListener('mouseup', onMarqueeEnd);
                document.removeEventListener('touchmove', onMarqueeMove);
                document.removeEventListener('touchend', onMarqueeEnd);
                document.removeEventListener('touchcancel', onMarqueeEnd);

                if (!marqueeRect || !marqueeSvg) { marqueeActive = false; return; }

                // Marquee bounds
                const mx = parseFloat(marqueeRect.getAttribute('x'));
                const my = parseFloat(marqueeRect.getAttribute('y'));
                const mw = parseFloat(marqueeRect.getAttribute('width'));
                const mh = parseFloat(marqueeRect.getAttribute('height'));

                // Remove marquee rectangle
                marqueeRect.remove();
                marqueeRect = null;
                marqueeActive = false;

                // Ignore tiny marquees (accidental clicks)
                if (mw < 5 && mh < 5) return;

                // Find elements intersecting the marquee
                const elements = marqueeSvg.querySelectorAll('path, rect, ellipse, line, text');
                multiSelectedAnnotations = [];

                elements.forEach(el => {
                    // Skip the marquee rect class itself (already removed, but safety)
                    if (el.classList.contains('marquee-rect')) return;

                    const bbox = el.getBBox();
                    let ex = bbox.x, ey = bbox.y;
                    const transform = el.getAttribute('transform');
                    if (transform) {
                        const match = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
                        if (match) { ex += parseFloat(match[1]); ey += parseFloat(match[2]); }
                    }

                    // AABB intersection test
                    if (ex + bbox.width > mx && ex < mx + mw &&
                        ey + bbox.height > my && ey < my + mh) {
                        el.classList.add('annotation-multi-selected');
                        multiSelectedAnnotations.push(el);
                    }
                });

                // Enable multi-drag if we selected anything
                if (multiSelectedAnnotations.length > 0) {
                    setupMultiDrag(marqueeSvg, marqueePageNum);
                }
            }

            document.addEventListener('mousemove', onMarqueeMove, { passive: false });
            document.addEventListener('mouseup', onMarqueeEnd);
            document.addEventListener('touchmove', onMarqueeMove, { passive: false });
            document.addEventListener('touchend', onMarqueeEnd);
            document.addEventListener('touchcancel', onMarqueeEnd);

            return true;
        }

        // Check if clicked on an annotation element
        if (target.closest('.annotationLayer') && target !== svg) {
            e.preventDefault();
            e.stopPropagation();

            selectAnnotation(target, svg, pageNum);

            // Start drag
            isDraggingAnnotation = true;
            annotationDragStartX = coords.clientX;
            annotationDragStartY = coords.clientY;

            target.classList.add('annotation-dragging');

            function onMove(ev) {
                if (!isDraggingAnnotation) return;
                ev.preventDefault();

                const moveCoords = getEventCoords(ev);
                const dxScreen = moveCoords.clientX - annotationDragStartX;
                const dyScreen = moveCoords.clientY - annotationDragStartY;

                // Convert screen delta to viewBox delta (rotation-aware)
                const vbDelta = screenDeltaToViewBox(svg, dxScreen, dyScreen, target);

                // Move the element
                moveAnnotation(target, vbDelta.dx, vbDelta.dy);

                // Update start position for next move
                annotationDragStartX = moveCoords.clientX;
                annotationDragStartY = moveCoords.clientY;
            }

            function onEnd(ev) {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onEnd);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
                document.removeEventListener('touchcancel', onEnd);

                target.classList.remove('annotation-dragging');
                isDraggingAnnotation = false;

                // Bug fix: Clamp annotation within page bounds to prevent cross-page loss
                const vbW = parseFloat(svg.dataset.viewboxWidth);
                const vbH = parseFloat(svg.dataset.viewboxHeight);
                clampAnnotationToPage(target, vbW, vbH);

                // Bug fix: Check if SVG is still in DOM before saving
                if (svg.isConnected) {
                    saveAnnotations(pageNum);
                }
            }

            document.addEventListener('mousemove', onMove, { passive: false });
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
            document.addEventListener('touchcancel', onEnd);

            return true;
        }

        return false;
    }

    // Multi-drag handler reference for cleanup
    let multiDragHandler = null;

    // Setup multi-drag for marquee-selected annotations
    function setupMultiDrag(svg, pageNum) {
        function startMultiDragHandler(e) {
            if (currentTool !== 'select') return;
            e.preventDefault();
            e.stopPropagation();

            const startCoords = getEventCoords(e);
            let lastX = startCoords.clientX;
            let lastY = startCoords.clientY;

            multiSelectedAnnotations.forEach(el => el.classList.add('annotation-dragging'));

            let multiDragRAF = null;
            let accDx = 0, accDy = 0;
            function onMove(ev) {
                ev.preventDefault();
                const moveCoords = getEventCoords(ev);
                accDx += moveCoords.clientX - lastX;
                accDy += moveCoords.clientY - lastY;
                lastX = moveCoords.clientX;
                lastY = moveCoords.clientY;

                if (!multiDragRAF) {
                    multiDragRAF = requestAnimationFrame(() => {
                        multiDragRAF = null;
                        const vbDelta = screenDeltaToViewBox(svg, accDx, accDy, multiSelectedAnnotations[0]);
                        accDx = 0; accDy = 0;
                        multiSelectedAnnotations.forEach(el => moveAnnotation(el, vbDelta.dx, vbDelta.dy));
                    });
                }
            }

            function onEnd() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onEnd);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
                document.removeEventListener('touchcancel', onEnd);

                multiSelectedAnnotations.forEach(el => el.classList.remove('annotation-dragging'));

                // Clamp all selected annotations within page bounds
                const vbW = parseFloat(svg.dataset.viewboxWidth);
                const vbH = parseFloat(svg.dataset.viewboxHeight);
                multiSelectedAnnotations.forEach(el => clampAnnotationToPage(el, vbW, vbH));

                if (svg.isConnected) saveAnnotations(pageNum);
            }

            document.addEventListener('mousemove', onMove, { passive: false });
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
            document.addEventListener('touchcancel', onEnd);
        }

        multiDragHandler = startMultiDragHandler;
        multiSelectedAnnotations.forEach(el => {
            el.style.cursor = 'grab';
            el.addEventListener('mousedown', startMultiDragHandler);
            el.addEventListener('touchstart', startMultiDragHandler, { passive: false });
        });
    }

    // moveAnnotation - applies delta movement to an annotation element
    function moveAnnotation(element, dx, dy) {
        if (element.tagName === 'path') {
            // Transform path using translate
            const currentTransform = element.getAttribute('transform') || '';
            const match = currentTransform.match(/translate\(([^,]+),\s*([^)]+)\)/);
            let tx = 0, ty = 0;
            if (match) {
                tx = parseFloat(match[1]);
                ty = parseFloat(match[2]);
            }
            element.setAttribute('transform', `translate(${tx + dx}, ${ty + dy})`);
        } else if (element.tagName === 'rect') {
            element.setAttribute('x', parseFloat(element.getAttribute('x')) + dx);
            element.setAttribute('y', parseFloat(element.getAttribute('y')) + dy);
        } else if (element.tagName === 'ellipse') {
            element.setAttribute('cx', parseFloat(element.getAttribute('cx')) + dx);
            element.setAttribute('cy', parseFloat(element.getAttribute('cy')) + dy);
        } else if (element.tagName === 'line') {
            element.setAttribute('x1', parseFloat(element.getAttribute('x1')) + dx);
            element.setAttribute('y1', parseFloat(element.getAttribute('y1')) + dy);
            element.setAttribute('x2', parseFloat(element.getAttribute('x2')) + dx);
            element.setAttribute('y2', parseFloat(element.getAttribute('y2')) + dy);
        } else if (element.tagName === 'text') {
            element.setAttribute('x', parseFloat(element.getAttribute('x')) + dx);
            element.setAttribute('y', parseFloat(element.getAttribute('y')) + dy);
        }
    }

    // Clamp annotation element within page viewBox bounds
    function clampAnnotationToPage(element, maxW, maxH) {
        const margin = 10;
        function clamp(val, min, max) { return Math.max(min, Math.min(val, max)); }

        if (element.tagName === 'path') {
            const transform = element.getAttribute('transform') || '';
            const match = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
            if (match) {
                const tx = clamp(parseFloat(match[1]), -maxW + margin, maxW - margin);
                const ty = clamp(parseFloat(match[2]), -maxH + margin, maxH - margin);
                element.setAttribute('transform', `translate(${tx}, ${ty})`);
            }
        } else if (element.tagName === 'rect') {
            element.setAttribute('x', clamp(parseFloat(element.getAttribute('x')), 0, maxW - margin));
            element.setAttribute('y', clamp(parseFloat(element.getAttribute('y')), 0, maxH - margin));
        } else if (element.tagName === 'ellipse') {
            element.setAttribute('cx', clamp(parseFloat(element.getAttribute('cx')), margin, maxW - margin));
            element.setAttribute('cy', clamp(parseFloat(element.getAttribute('cy')), margin, maxH - margin));
        } else if (element.tagName === 'line') {
            element.setAttribute('x1', clamp(parseFloat(element.getAttribute('x1')), 0, maxW));
            element.setAttribute('y1', clamp(parseFloat(element.getAttribute('y1')), 0, maxH));
            element.setAttribute('x2', clamp(parseFloat(element.getAttribute('x2')), 0, maxW));
            element.setAttribute('y2', clamp(parseFloat(element.getAttribute('y2')), 0, maxH));
        } else if (element.tagName === 'text') {
            element.setAttribute('x', clamp(parseFloat(element.getAttribute('x')), 0, maxW - margin));
            element.setAttribute('y', clamp(parseFloat(element.getAttribute('y')), margin, maxH - margin));
        }
    }

    // Legacy function for backwards compatibility (used elsewhere)
    function handleSelectMouseDown(e, svg, pageNum) {
        return handleSelectPointerDown(e, svg, pageNum);
    }

    // ==========================================
    // KEYBOARD SHORTCUTS
    // ==========================================
    document.addEventListener('keydown', (e) => {
        // Ignore if typing in input
        if (e.target.tagName === 'INPUT' || e.target.contentEditable === 'true') return;

        const key = e.key.toLowerCase();

        // Tool shortcuts
        if (key === 'h') { setTool('highlight'); e.preventDefault(); }
        if (key === 'p') { setTool('pen'); e.preventDefault(); }
        if (key === 'e') { setTool('eraser'); e.preventDefault(); }
        if (key === 't') { setTool('text'); e.preventDefault(); }
        if (key === 'r') { setTool('shape'); e.preventDefault(); }
        if (key === 'v') { setTool('select'); e.preventDefault(); }
        if (key === 'f') { toggleFullscreen(); e.preventDefault(); }

        // Delete selected annotation(s)
        if ((key === 'delete' || key === 'backspace') && (selectedAnnotation || multiSelectedAnnotations.length > 0)) {
            deleteSelectedAnnotation();
            e.preventDefault();
        }

        // Undo/Redo
        if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
            performUndo();
            e.preventDefault();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (key === 'y' || (key === 'z' && e.shiftKey))) {
            performRedo();
            e.preventDefault();
            return;
        }

        // Copy/Paste annotations
        if ((e.ctrlKey || e.metaKey) && key === 'c' && selectedAnnotation) {
            copySelectedAnnotation();
            e.preventDefault();
        }
        if ((e.ctrlKey || e.metaKey) && key === 'v' && copiedAnnotation) {
            pasteAnnotation();
            e.preventDefault();
        }

        // Navigation
        if (key === 's') {
            document.getElementById('sidebarBtn').click();
            e.preventDefault();
        }

        // Arrow key navigation
        if (key === 'arrowleft' || key === 'arrowup') {
            if (pdfViewer && pdfViewer.currentPageNumber > 1) {
                pdfViewer.currentPageNumber--;
            }
            e.preventDefault();
        }
        if (key === 'arrowright' || key === 'arrowdown') {
            if (pdfViewer && pdfViewer.currentPageNumber < pdfViewer.pagesCount) {
                pdfViewer.currentPageNumber++;
            }
            e.preventDefault();
        }

        // Home/End
        if (key === 'home') {
            if (pdfViewer) pdfViewer.currentPageNumber = 1;
            e.preventDefault();
        }
        if (key === 'end') {
            if (pdfViewer) pdfViewer.currentPageNumber = pdfViewer.pagesCount;
            e.preventDefault();
        }

        // Zoom shortcuts - prevent browser zoom
        if ((e.ctrlKey || e.metaKey) && (key === '=' || key === '+' || e.code === 'Equal')) {
            e.preventDefault();
            e.stopPropagation();
            pdfViewer.currentScale += 0.25;
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (key === '-' || e.code === 'Minus')) {
            e.preventDefault();
            e.stopPropagation();
            pdfViewer.currentScale -= 0.25;
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (key === '0' || e.code === 'Digit0')) {
            e.preventDefault();
            e.stopPropagation();
            pdfViewer.currentScaleValue = 'page-width';
            return;
        }

        // Escape to deselect tool
        if (key === 'escape') {
            if (currentTool) {
                setTool(currentTool); // Toggle off
            }
            closeAllDropdowns();
        }

        // Sepia mode
        if (key === 'm') {
            document.getElementById('sepiaBtn').click();
            e.preventDefault();
        }
    });

    // ==========================================
    // CONTEXT MENU (Right-click)
    // ==========================================
    const contextMenu = document.createElement('div');
    contextMenu.className = 'contextMenu';
    contextMenu.innerHTML = `
    <div class="contextMenuItem" data-action="highlight">
        <svg viewBox="0 0 24 24"><path d="M3 21h18v-2H3v2zM5 16h14l-3-10H8l-3 10z"/></svg>
        Vurgula
        <span class="shortcutHint">H</span>
    </div>
    <div class="contextMenuItem" data-action="pen">
        <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        Kalem
        <span class="shortcutHint">P</span>
    </div>
    <div class="contextMenuItem" data-action="text">
        <svg viewBox="0 0 24 24"><path d="M5 4v3h5.5v12h3V7H19V4H5z"/></svg>
        Metin Ekle
        <span class="shortcutHint">T</span>
    </div>
    <div class="contextMenuDivider"></div>
    <div class="contextMenuItem" data-action="zoomIn">
        <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        Yakınlaştır
        <span class="shortcutHint">Ctrl++</span>
    </div>
    <div class="contextMenuItem" data-action="zoomOut">
        <svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>
        Uzaklaştır
        <span class="shortcutHint">Ctrl+-</span>
    </div>
    <div class="contextMenuDivider"></div>
    <div class="contextMenuItem" data-action="sepia">
        <svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>
        Okuma Modu
        <span class="shortcutHint">M</span>
    </div>
`;
    document.body.appendChild(contextMenu);

    // Show context menu on right-click in viewer
    function showCustomContextMenu(e) {
        e.preventDefault();
        contextMenu.style.left = e.clientX + 'px';
        contextMenu.style.top = e.clientY + 'px';
        contextMenu.classList.add('visible');
    }
    container.addEventListener('contextmenu', showCustomContextMenu);

    // Hide context menu on click
    document.addEventListener('click', () => {
        contextMenu.classList.remove('visible');
    });

    // Context menu actions
    contextMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.contextMenuItem');
        if (!item) return;

        const action = item.dataset.action;
        switch (action) {
            case 'highlight': setTool('highlight'); break;
            case 'pen': setTool('pen'); break;
            case 'text': setTool('text'); break;
            case 'zoomIn': pdfViewer.currentScale += 0.25; break;
            case 'zoomOut': pdfViewer.currentScale -= 0.25; break;
            case 'sepia': document.getElementById('sepiaBtn').click(); break;
        }
        contextMenu.classList.remove('visible');
    });

    // ==========================================
    // ERGONOMIC FEATURES
    // ==========================================

    // Fullscreen toggle function
    function toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen().catch(() => { });
        }
    }

    // Update fullscreen button icon
    function updateFullscreenIcon() {
        const icon = document.getElementById('fullscreenIcon');
        const btn = document.getElementById('fullscreenBtn');
        if (document.fullscreenElement) {
            icon.innerHTML = '<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>';
            btn.classList.add('active');
        } else {
            icon.innerHTML = '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>';
            btn.classList.remove('active');
        }
    }

    document.addEventListener('fullscreenchange', updateFullscreenIcon);

    // Fullscreen button click
    document.getElementById('fullscreenBtn').onclick = () => toggleFullscreen();

    // Double-click on page for fullscreen
    let lastClickTime = 0;
    container.addEventListener('click', (e) => {
        const now = Date.now();
        if (now - lastClickTime < 300) {
            toggleFullscreen();
        }
        lastClickTime = now;
    });

    // Auto-fullscreen when viewer loads inside iframe
    if (window.self !== window.top && window.PDF_SECURE_CONFIG) {
        // We're inside an iframe - request fullscreen on first user interaction
        const autoFullscreen = () => {
            document.documentElement.requestFullscreen().catch(() => { });
            container.removeEventListener('click', autoFullscreen);
            container.removeEventListener('touchstart', autoFullscreen);
        };
        container.addEventListener('click', autoFullscreen, { once: true });
        container.addEventListener('touchstart', autoFullscreen, { once: true });
    }

    // Mouse wheel zoom with Ctrl (debounced, clamped 0.5x-5x)
    let zoomTimeout;
    container.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        clearTimeout(zoomTimeout);
        const delta = e.deltaY < 0 ? 0.1 : -0.1;
        zoomTimeout = setTimeout(() => {
            pdfViewer.currentScale = Math.max(0.5, Math.min(5, pdfViewer.currentScale + delta));
        }, 30);
    }, { passive: false });

    console.log('PDF Viewer Ready');
    console.log('Keyboard Shortcuts: H=Highlight, P=Pen, E=Eraser, T=Text, R=Shapes, S=Sidebar, M=ReadingMode, Arrows=Navigate');

    // ==========================================
    // MOBILE / TABLET SUPPORT
    // ==========================================
    const isMobile = () => window.innerWidth <= 599;
    const isTabletPortrait = () => {
        const w = window.innerWidth;
        return w >= 600 && w <= 1024 && window.innerHeight > window.innerWidth;
    };
    const isTouch = () => 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    // Bottom toolbar element references
    const bottomToolbarInner = document.getElementById('bottomToolbarInner');

    // Elements to move between top toolbar and bottom toolbar on mobile
    // We identify the annotation tools group (highlighter, pen, eraser, select, separator, undo, redo, clearAll, separator, text, shapes)
    const annotationToolsSelector = '#toolbar > .toolbarGroup:nth-child(3)';
    let toolsMovedToBottom = false;
    let annotationToolsPlaceholder = null;

    function setupResponsiveToolbar() {
        const needsBottomBar = isMobile() || isTabletPortrait();

        if (needsBottomBar && !toolsMovedToBottom) {
            // Move annotation tools to bottom toolbar
            const annotationGroup = document.querySelector(annotationToolsSelector);
            if (annotationGroup && bottomToolbarInner) {
                // Create placeholder to remember position
                annotationToolsPlaceholder = document.createComment('annotation-tools-placeholder');
                annotationGroup.parentNode.insertBefore(annotationToolsPlaceholder, annotationGroup);

                // Move children into bottom toolbar
                while (annotationGroup.firstChild) {
                    bottomToolbarInner.appendChild(annotationGroup.firstChild);
                }
                // Hide empty group
                annotationGroup.style.display = 'none';
                toolsMovedToBottom = true;
            }
        } else if (!needsBottomBar && toolsMovedToBottom) {
            // Move tools back to top toolbar
            const annotationGroup = document.querySelector(annotationToolsSelector);
            if (annotationGroup && bottomToolbarInner && annotationToolsPlaceholder) {
                while (bottomToolbarInner.firstChild) {
                    annotationGroup.appendChild(bottomToolbarInner.firstChild);
                }
                annotationGroup.style.display = '';
                toolsMovedToBottom = false;
            }
        }
    }

    // Run on load
    setupResponsiveToolbar();

    // Use matchMedia for responsive switching
    const mobileMediaQuery = window.matchMedia('(max-width: 599px)');
    mobileMediaQuery.addEventListener('change', () => {
        setupResponsiveToolbar();
    });

    const tabletPortraitQuery = window.matchMedia(
        '(min-width: 600px) and (max-width: 1024px) and (orientation: portrait)'
    );
    tabletPortraitQuery.addEventListener('change', () => {
        setupResponsiveToolbar();
    });

    // Also handle resize for orientation changes
    window.addEventListener('resize', () => {
        setupResponsiveToolbar();
    });

    // ==========================================
    // PINCH-TO-ZOOM (Touch devices)
    // ==========================================
    let pinchStartDistance = 0;
    let pinchStartScale = 1;
    let isPinching = false;

    function getTouchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    container.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2 && !currentTool) {
            isPinching = true;
            pinchStartDistance = getTouchDistance(e.touches);
            pinchStartScale = pdfViewer.currentScale;
            e.preventDefault();
        }
    }, { passive: false });

    container.addEventListener('touchmove', (e) => {
        if (isPinching && e.touches.length === 2) {
            const dist = getTouchDistance(e.touches);
            const ratio = dist / pinchStartDistance;
            const newScale = Math.min(Math.max(pinchStartScale * ratio, 0.5), 5.0);
            pdfViewer.currentScale = newScale;
            e.preventDefault();
        }
    }, { passive: false });

    container.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) {
            isPinching = false;
        }
    });

    // ==========================================
    // CONTEXT MENU TOUCH HANDLING
    // ==========================================
    // On pure touch devices (no fine pointer), don't show custom context menu
    if (isTouch() && !window.matchMedia('(pointer: fine)').matches) {
        container.removeEventListener('contextmenu', showCustomContextMenu);
    }

    // ==========================================
    // SECURITY FEATURES
    // ==========================================

    (function initSecurityFeatures() {
        // 1. Block dangerous keyboard shortcuts (consolidated)
        const blockedCtrlKeys = new Set(['s', 'p', 'u']);
        const blockedCtrlShiftKeys = new Set(['s', 'i', 'j', 'c']);
        document.addEventListener('keydown', function (e) {
            const key = e.key.toLowerCase();
            if (e.key === 'F12') { e.preventDefault(); return; }
            if (e.ctrlKey && e.shiftKey && blockedCtrlShiftKeys.has(key)) { e.preventDefault(); return; }
            if (e.ctrlKey && !e.shiftKey && blockedCtrlKeys.has(key)) { e.preventDefault(); return; }
        }, true);

        // 2. Block context menu (right-click) - skip annotation layer custom menu
        document.addEventListener('contextmenu', function (e) {
            if (e.target.closest('.annotationLayer')) return;
            e.preventDefault();
        }, true);

        // 3. Block copy/cut
        document.addEventListener('copy', (e) => { e.preventDefault(); }, true);
        document.addEventListener('cut', (e) => { e.preventDefault(); }, true);

        // 4. Block drag events
        document.addEventListener('dragstart', (e) => { e.preventDefault(); }, true);

        // 5. Block Print
        window.print = function () {
            alert('Yazdırma bu belgede engellenmiştir.');
        };

        // 6. Print event protection
        window.addEventListener('beforeprint', () => { document.body.style.display = 'none'; });
        window.addEventListener('afterprint', () => { document.body.style.display = ''; });
    })();

    // End of main IIFE - pdfDoc, pdfViewer not accessible from console
})();
