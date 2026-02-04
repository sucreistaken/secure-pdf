<div class="secure-pdf-viewer-page">
	<div id="spdf-standalone-viewer" class="spdf-viewer-wrapper" style="width:100%; height:85vh;"></div>
</div>

<script>
$(document).ready(function () {
	var urlParams = new URLSearchParams(window.location.search);
	var pdfUrl = urlParams.get('url');
	var container = document.getElementById('spdf-standalone-viewer');

	if (!pdfUrl) {
		container.innerHTML =
			'<div style="text-align:center; padding:60px; color:rgba(255,255,255,0.5);">' +
				'<div style="font-size:48px; margin-bottom:16px;">&#128196;</div>' +
				'<p style="font-size:16px; margin-bottom:8px;">PDF URL belirtilmedi</p>' +
				'<p style="font-size:13px; color:rgba(255,255,255,0.3);">Kullanim: /pdf-viewer?url=https://example.com/file.pdf</p>' +
			'</div>';
		return;
	}

	container.innerHTML =
		'<div style="display:flex; align-items:center; justify-content:center; gap:10px; padding:40px; color:rgba(255,255,255,0.6);">' +
			'<div style="width:20px; height:20px; border:2px solid rgba(255,255,255,0.2); border-top-color:#FFCA28; border-radius:50%; animation:spdf-spin 0.8s linear infinite;"></div>' +
			'<span>Yukleniyor...</span>' +
		'</div>';

	fetch(config.relative_path + '/api/secure-pdf/token', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-csrf-token': config.csrf_token,
		},
		body: JSON.stringify({ pdfUrl: pdfUrl }),
	})
	.then(function (r) { return r.json(); })
	.then(function (data) {
		if (!data || !data.response || !data.response.token) {
			throw new Error(data && data.response && data.response.error || 'Token alinamadi');
		}

		require(['secure-pdf/viewer'], function (Viewer) {
			container.innerHTML = '';
			var viewer = Viewer.init('#spdf-standalone-viewer', {
				token: data.response.token,
				hasFullAccess: data.response.hasFullAccess,
				freePageLimit: data.response.freePageLimit,
			});
			if (viewer) viewer.loadFromServer(data.response.token);
		});
	})
	.catch(function (err) {
		console.error('Secure PDF error:', err);
		container.innerHTML =
			'<div style="text-align:center; padding:60px; color:rgba(255,255,255,0.5);">' +
				'<div style="font-size:48px; margin-bottom:16px;">&#9888;&#65039;</div>' +
				'<p style="font-size:16px; color:#f44336;">PDF yuklenemedi</p>' +
				'<p style="font-size:13px; color:rgba(255,255,255,0.3); margin-top:8px;">' + err.message + '</p>' +
			'</div>';
	});
});
</script>
