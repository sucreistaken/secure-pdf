'use strict';

/**
 * Secure PDF Viewer - V5 Sidebar Ultimate
 * Features:
 * - Mozilla PDFViewer (Virtual Scrolling & Performance)
 * - Sidebar UI (V2 Style) with Material Icons
 * - Tippy.js Tooltips
 */

define('secure-pdf/viewer', [], function () {
    const Viewer = {};

    // CDN Resources
    const PDFJS_VERSION = '3.11.174';
    const RESOURCES = {
        CSS_VIEWER: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf_viewer.min.css`,
        CSS_ICONS: 'https://fonts.googleapis.com/icon?family=Material+Icons+Round',
        CSS_TIPPY: 'https://unpkg.com/tippy.js@6/animations/scale.css',

        JS_PDF: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`,
        JS_WORKER: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`,
        JS_VIEWER: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf_viewer.min.js`,
        JS_ANNOTATE: 'https://cdn.jsdelivr.net/npm/pdf-annotate.js@1.0.1/dist/pdf-annotate.min.js',
        JS_POPPER: 'https://unpkg.com/@popperjs/core@2',
        JS_TIPPY: 'https://unpkg.com/tippy.js@6'
    };

    let pdfViewer = null;
    let eventBus = null;
    let pdfLinkService = null;

    Viewer.init = async function (containerSelector, options = {}) {
        const container = document.querySelector(containerSelector);
        if (!container) return;

        // 1. Load Resources
        await loadResources();

        // 2. Setup Worker
        pdfjsLib.GlobalWorkerOptions.workerSrc = RESOURCES.JS_WORKER;

        // 3. Render UI (Sidebar)
        renderUI(container);

        // 4. Init PDFViewer
        initPDFViewer(container);

        // 5. Init Tooltips
        tippy('[data-tippy-content]', { animation: 'scale', theme: 'translucent', placement: 'right' });

        console.log('⚡ Secure PDF V5 (Sidebar Ultimate) Initialized');
    };

    Viewer.loadPDF = async function (pdfUrl) {
        try {
            const loadingTask = pdfjsLib.getDocument(pdfUrl);
            const pdfDoc = await loadingTask.promise;

            pdfViewer.setDocument(pdfDoc);
            pdfLinkService.setDocument(pdfDoc, null);

            // Update UI
            if (document.getElementById('doc-title')) {
                document.getElementById('doc-title').textContent = 'Loaded Document';
            }

        } catch (err) {
            console.error('PDF Load Error:', err);
        }
    };

    function loadResources() {
        return Promise.all([
            loadCSS(RESOURCES.CSS_VIEWER),
            loadCSS(RESOURCES.CSS_ICONS),
            loadCSS(RESOURCES.CSS_TIPPY),
            loadScript(RESOURCES.JS_PDF).then(() => loadScript(RESOURCES.JS_VIEWER)),
            loadScript(RESOURCES.JS_ANNOTATE),
            loadScript(RESOURCES.JS_POPPER).then(() => loadScript(RESOURCES.JS_TIPPY))
        ]);
    }

    function loadCSS(url) {
        return new Promise(resolve => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = url;
            link.onload = resolve;
            document.head.appendChild(link);
        });
    }

    function loadScript(url) {
        return new Promise(resolve => {
            if (document.querySelector(`script[src="${url}"]`)) return resolve();
            const script = document.createElement('script');
            script.src = url;
            script.onload = resolve;
            document.head.appendChild(script);
        });
    }

    function renderUI(container) {
        // Inject Styles
        const style = document.createElement('style');
        style.textContent = `
            :root { --sidebar-width: 60px; --primary: #FFCA28; --bg: #121212; --surface: #1e1e1e; --border: rgba(255, 255, 255, 0.1); }
            
            .spdf-sidebar {
                width: var(--sidebar-width); background: var(--surface);
                border-right: 1px solid var(--border); display: flex; flex-direction: column;
                align-items: center; padding: 16px 0; gap: 12px; z-index: 100;
            }
            .spdf-tool-btn {
                width: 40px; height: 40px; border-radius: 10px; border: none; background: transparent;
                color: rgba(255,255,255,0.6); cursor: pointer; position: relative;
                display: flex; align-items: center; justify-content: center;
            }
            .spdf-tool-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
            .spdf-tool-btn.active { background: rgba(255,202,40,0.15); color: var(--primary); }
            .spdf-tool-btn.active::before {
                content: ''; position: absolute; left: -8px; top: 10px; bottom: 10px; width: 3px;
                background: var(--primary); border-radius: 0 4px 4px 0;
            }
            .spdf-separator { width: 24px; height: 1px; background: var(--border); margin: 4px 0; }
            
            #spdf-viewer-container {
                position: absolute; top: 0; bottom: 0; left: var(--sidebar-width); right: 0; overflow: auto; background: var(--bg);
            }
            
            .pdfViewer .page { margin: 30px auto !important; border: none !important; box-shadow: 0 10px 40px rgba(0,0,0,0.5) !important; }
        `;
        container.appendChild(style);

        container.style.display = 'flex';
        container.style.height = '100vh';
        container.style.overflow = 'hidden';
        container.style.position = 'relative';

        container.innerHTML += `
            <div class="spdf-sidebar">
                <button class="spdf-tool-btn active" id="spdf-cursor" data-tippy-content="Select">
                    <span class="material-icons-round">near_me</span>
                </button>
                <div class="spdf-separator"></div>
                <button class="spdf-tool-btn" id="spdf-highlight" data-tippy-content="Highlight">
                    <span class="material-icons-round">edit</span>
                </button>
                <button class="spdf-tool-btn" id="spdf-pen" data-tippy-content="Pen">
                    <span class="material-icons-round">brush</span>
                </button>
                <button class="spdf-tool-btn" id="spdf-text" data-tippy-content="Text">
                    <span class="material-icons-round">text_fields</span>
                </button>
                <button class="spdf-tool-btn" id="spdf-rect" data-tippy-content="Rectangle">
                    <span class="material-icons-round">check_box_outline_blank</span>
                </button>
                 <div class="spdf-separator"></div>
                <button class="spdf-tool-btn" id="spdf-undo" data-tippy-content="Undo">
                    <span class="material-icons-round">undo</span>
                </button>
                <div style="margin-top:auto"></div>
                <button class="spdf-tool-btn" id="spdf-fullscreen" data-tippy-content="Fullscreen">
                    <span class="material-icons-round">fullscreen</span>
                </button>
            </div>

            <div id="spdf-viewer-container">
                <div id="viewer" class="pdfViewer"></div>
            </div>
        `;

        // Fullscreen Logic
        container.querySelector('#spdf-fullscreen').onclick = () => {
            if (document.fullscreenElement) document.exitFullscreen();
            else container.requestFullscreen();
        };

        // Tool Switching
        const tools = ['spdf-cursor', 'spdf-highlight', 'spdf-pen', 'spdf-text', 'spdf-rect'];
        tools.forEach(id => {
            container.querySelector(`#${id}`).onclick = () => {
                tools.forEach(t => container.querySelector(`#${t}`).classList.remove('active'));
                container.querySelector(`#${id}`).classList.add('active');
            };
        });
    }

    function initPDFViewer(container) {
        const viewerContainer = container.querySelector('#spdf-viewer-container');
        eventBus = new pdfjsViewer.EventBus();
        pdfLinkService = new pdfjsViewer.PDFLinkService({ eventBus });

        pdfViewer = new pdfjsViewer.PDFViewer({
            container: viewerContainer,
            eventBus: eventBus,
            linkService: pdfLinkService,
            removePageBorders: true
        });

        pdfLinkService.setViewer(pdfViewer);

        eventBus.on('pagesinit', () => {
            pdfViewer.currentScaleValue = 'auto';
        });
    }

    return Viewer;
});
