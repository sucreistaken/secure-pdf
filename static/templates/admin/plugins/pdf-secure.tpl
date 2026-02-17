<div class="acp-page-container">
	<!-- IMPORT admin/partials/settings/header.tpl -->

	<div class="row m-0">
		<div id="spy-container" class="col-12 col-md-8 px-0 mb-4" tabindex="0">
			<form role="form" class="pdf-secure-settings">
				<div class="mb-4">
					<h5 class="fw-bold tracking-tight settings-header">PDF Secure Viewer Settings</h5>

					<p class="lead">
						Configure the secure PDF viewer plugin settings below.
					</p>

					<div class="mb-3">
						<label class="form-label" for="premiumGroup">Premium Group Name</label>
						<input type="text" id="premiumGroup" name="premiumGroup" title="Premium Group Name" class="form-control" placeholder="Premium" value="Premium">
						<div class="form-text">Users in this group can view full PDFs. Others can only see the first page.</div>
					</div>

					<div class="form-check form-switch mb-3">
						<input type="checkbox" class="form-check-input" id="watermarkEnabled" name="watermarkEnabled">
						<label for="watermarkEnabled" class="form-check-label">Enable Watermark</label>
						<div class="form-text">Show a watermark overlay on PDF pages.</div>
					</div>
				</div>
			</form>
		</div>

		<!-- IMPORT admin/partials/settings/toc.tpl -->
	</div>
</div>
