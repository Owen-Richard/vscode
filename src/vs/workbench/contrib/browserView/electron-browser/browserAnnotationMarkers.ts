/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IBrowserAnnotation } from '../common/browserAnnotation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { IElementData } from '../../../../platform/browserElements/common/browserElements.js';

/**
 * Result from waiting for a user annotation in the page.
 */
export interface IAnnotationClickResult {
	readonly elementData: IElementData;
	readonly comment: string;
}

/**
 * Self-contained JavaScript that gets injected into the target browser page
 * to render numbered annotation markers. The script manages its own DOM
 * elements and provides an update function on window.__annotationMarkers.
 */
const MARKER_INJECTION_SCRIPT = `
(function() {
	if (window.__annotationMarkers) {
		return; // Already injected
	}

	const CONTAINER_ID = '__vscode-annotation-markers';
	const STYLE_ID = '__vscode-annotation-markers-style';

	function ensureStyles() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = \`
			#\${CONTAINER_ID} {
				position: absolute;
				top: 0;
				left: 0;
				width: 0;
				height: 0;
				pointer-events: none;
				z-index: 2147483646;
			}
			.\${CONTAINER_ID}-marker {
				position: absolute;
				width: 22px;
				height: 22px;
				border-radius: 50%;
				background: #0078d4;
				color: #fff;
				font-size: 12px;
				font-weight: 600;
				font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
				display: flex;
				align-items: center;
				justify-content: center;
				box-shadow: 0 1px 4px rgba(0,0,0,0.3);
				pointer-events: auto;
				cursor: default;
				transform: translate(-50%, -50%);
				transition: transform 0.15s ease;
				user-select: none;
				-webkit-user-select: none;
			}
			.\${CONTAINER_ID}-marker:hover {
				transform: translate(-50%, -50%) scale(1.2);
			}
			.\${CONTAINER_ID}-highlight {
				position: absolute;
				border: 2px solid #0078d4;
				background: rgba(0, 120, 212, 0.08);
				border-radius: 3px;
				pointer-events: none;
				transition: opacity 0.2s ease;
			}
		\`;
		document.head.appendChild(style);
	}

	function ensureContainer() {
		let container = document.getElementById(CONTAINER_ID);
		if (!container) {
			container = document.createElement('div');
			container.id = CONTAINER_ID;
			document.body.appendChild(container);
		}
		return container;
	}

	function findElement(annotation) {
		// Try to find element by building a selector from ancestors
		if (annotation.ancestors && annotation.ancestors.length > 0) {
			const last = annotation.ancestors[annotation.ancestors.length - 1];
			if (last.id) {
				const el = document.getElementById(last.id);
				if (el) return el;
			}
		}

		// Try matching by attributes
		if (annotation.attributes) {
			if (annotation.attributes.id) {
				const el = document.getElementById(annotation.attributes.id);
				if (el) return el;
			}
			if (annotation.attributes['data-testid']) {
				const el = document.querySelector('[data-testid="' + CSS.escape(annotation.attributes['data-testid']) + '"]');
				if (el) return el;
			}
		}

		// Fallback: find by position (bounding box)
		if (annotation.bounds) {
			const centerX = annotation.bounds.x + annotation.bounds.width / 2;
			const centerY = annotation.bounds.y + annotation.bounds.height / 2;
			const el = document.elementFromPoint(centerX, centerY);
			if (el && el !== document.body && el !== document.documentElement) {
				return el;
			}
		}

		return null;
	}

	function updateMarkers(annotations) {
		ensureStyles();
		const container = ensureContainer();
		container.innerHTML = '';

		for (const annotation of annotations) {
			const element = findElement(annotation);
			if (!element) continue;

			const rect = element.getBoundingClientRect();
			const scrollX = window.scrollX;
			const scrollY = window.scrollY;

			// Highlight outline
			const highlight = document.createElement('div');
			highlight.className = CONTAINER_ID + '-highlight';
			highlight.style.left = (rect.left + scrollX - 2) + 'px';
			highlight.style.top = (rect.top + scrollY - 2) + 'px';
			highlight.style.width = (rect.width + 4) + 'px';
			highlight.style.height = (rect.height + 4) + 'px';
			container.appendChild(highlight);

			// Numbered marker badge
			const marker = document.createElement('div');
			marker.className = CONTAINER_ID + '-marker';
			marker.textContent = String(annotation.index);
			marker.title = annotation.comment;
			marker.style.left = (rect.right + scrollX) + 'px';
			marker.style.top = (rect.top + scrollY) + 'px';
			container.appendChild(marker);
		}
	}

	function clearMarkers() {
		const container = document.getElementById(CONTAINER_ID);
		if (container) {
			container.innerHTML = '';
		}
	}

	function removeAll() {
		const container = document.getElementById(CONTAINER_ID);
		if (container) container.remove();
		const style = document.getElementById(STYLE_ID);
		if (style) style.remove();
		delete window.__annotationMarkers;
	}

	window.__annotationMarkers = {
		update: updateMarkers,
		clear: clearMarkers,
		remove: removeAll
	};
})();
`;

/**
 * Self-contained JavaScript that gets injected into the target page to provide
 * custom hover highlighting and element selection, matching the mini-tool
 * agentation prototype's visual behavior.
 *
 * When active:
 * - Mousemove shows a semi-transparent highlight box around the hovered element
 * - A tooltip near the cursor shows the element's identified name
 * - Click captures the element and stores its data for VS Code to retrieve
 */
const HOVER_OVERLAY_SCRIPT = `
(function() {
	if (window.__annotationHover) return;

	const HOVER_ID = '__vscode-annotation-hover';
	const STYLE_ID = '__vscode-annotation-hover-style';

	function ensureStyles() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = [
			'#' + HOVER_ID + '-highlight {',
			'  position: fixed;',
			'  border: 2px solid rgba(0, 120, 212, 0.5);',
			'  border-radius: 4px;',
			'  background-color: rgba(0, 120, 212, 0.04);',
			'  pointer-events: none;',
			'  box-sizing: border-box;',
			'  z-index: 2147483645;',
			'  display: none;',
			'  transition: top 0.06s ease-out, left 0.06s ease-out, width 0.06s ease-out, height 0.06s ease-out;',
			'}',
			'#' + HOVER_ID + '-highlight.visible {',
			'  display: block;',
			'  animation: __ann_hoverIn 0.12s ease-out forwards;',
			'}',
			'@keyframes __ann_hoverIn {',
			'  from { opacity: 0; transform: scale(0.98); }',
			'  to { opacity: 1; transform: scale(1); }',
			'}',
			'#' + HOVER_ID + '-tooltip {',
			'  position: fixed;',
			'  font-size: 11px;',
			'  font-weight: 500;',
			'  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
			'  color: #fff;',
			'  background: rgba(0, 0, 0, 0.85);',
			'  padding: 4px 8px;',
			'  border-radius: 6px;',
			'  pointer-events: none;',
			'  white-space: nowrap;',
			'  max-width: 280px;',
			'  overflow: hidden;',
			'  text-overflow: ellipsis;',
			'  z-index: 2147483645;',
			'  display: none;',
			'}',
			'#' + HOVER_ID + '-tooltip.visible {',
			'  display: block;',
			'  animation: __ann_tooltipIn 0.1s ease-out forwards;',
			'}',
			'@keyframes __ann_tooltipIn {',
			'  from { opacity: 0; transform: scale(0.95) translateY(4px); }',
			'  to { opacity: 1; transform: scale(1) translateY(0); }',
			'}',
		].join('\\n');
		document.head.appendChild(style);
	}

	let highlight = null;
	let tooltip = null;
	let active = false;
	let clickResolve = null;

	function ensureElements() {
		if (!highlight) {
			highlight = document.createElement('div');
			highlight.id = HOVER_ID + '-highlight';
			document.body.appendChild(highlight);
		}
		if (!tooltip) {
			tooltip = document.createElement('div');
			tooltip.id = HOVER_ID + '-tooltip';
			document.body.appendChild(tooltip);
		}
	}

	function identifyElement(el) {
		const tag = el.tagName.toLowerCase();
		if (tag === 'button') {
			const text = el.textContent?.trim();
			const ariaLabel = el.getAttribute('aria-label');
			if (ariaLabel) return 'button [' + ariaLabel + ']';
			return text ? 'button "' + text.slice(0, 25) + '"' : 'button';
		}
		if (tag === 'a') {
			const text = el.textContent?.trim();
			if (text) return 'link "' + text.slice(0, 25) + '"';
			return 'link';
		}
		if (tag === 'input') {
			const type = el.getAttribute('type') || 'text';
			const ph = el.getAttribute('placeholder');
			if (ph) return 'input "' + ph + '"';
			return type + ' input';
		}
		if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
			const text = el.textContent?.trim();
			return text ? tag + ' "' + text.slice(0, 35) + '"' : tag;
		}
		if (tag === 'img') {
			const alt = el.getAttribute('alt');
			return alt ? 'image "' + alt.slice(0, 30) + '"' : 'image';
		}
		if (tag === 'p') {
			const text = el.textContent?.trim();
			if (text) return 'paragraph: "' + text.slice(0, 40) + (text.length > 40 ? '...' : '') + '"';
			return 'paragraph';
		}
		if (tag === 'span' || tag === 'label') {
			const text = el.textContent?.trim();
			if (text && text.length < 40) return '"' + text + '"';
			return tag;
		}
		if (['div','section','article','nav','header','footer','aside','main'].includes(tag)) {
			const role = el.getAttribute('role');
			const ariaLabel = el.getAttribute('aria-label');
			if (ariaLabel) return tag + ' [' + ariaLabel + ']';
			if (role) return role;
			const cn = el.className;
			if (typeof cn === 'string' && cn) {
				const words = cn.split(/[\\s_-]+/)
					.map(c => c.replace(/[A-Z0-9]{5,}.*$/, ''))
					.filter(c => c.length > 2 && !/^[a-z]{1,2}$/.test(c))
					.slice(0, 2);
				if (words.length > 0) return words.join(' ');
			}
			return tag === 'div' ? 'container' : tag;
		}
		return tag;
	}

	function onMouseMove(e) {
		if (!active) return;
		const el = document.elementFromPoint(e.clientX, e.clientY);
		if (!el || el === highlight || el === tooltip ||
			el === document.body || el === document.documentElement) {
			highlight.classList.remove('visible');
			tooltip.classList.remove('visible');
			return;
		}
		// Skip our own injected elements
		if (el.id && el.id.startsWith('__vscode-annotation')) return;

		const rect = el.getBoundingClientRect();
		highlight.style.left = rect.left + 'px';
		highlight.style.top = rect.top + 'px';
		highlight.style.width = rect.width + 'px';
		highlight.style.height = rect.height + 'px';
		highlight.classList.add('visible');

		const name = identifyElement(el);
		tooltip.textContent = name;
		tooltip.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - 200)) + 'px';
		tooltip.style.top = Math.max(e.clientY - 32, 8) + 'px';
		tooltip.classList.add('visible');
	}

	let clickedElement = null;

	function onClick(e) {
		if (!active) return;
		const el = document.elementFromPoint(e.clientX, e.clientY);
		if (!el || el.id?.startsWith('__vscode-annotation')) return;

		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();

		// Store clicked element for later data extraction
		clickedElement = el;

		// Pause hover tracking while popup is shown
		active = false;
		highlight.classList.remove('visible');
		tooltip.classList.remove('visible');

		const elementName = identifyElement(el);
		const rect = el.getBoundingClientRect();

		showPopup(elementName, e.clientX, rect.bottom + 12);
	}

	// -- Annotation Popup -----------------------------------------------

	let popupEl = null;

	function showPopup(elementName, x, y) {
		removePopup();

		popupEl = document.createElement('div');
		popupEl.id = HOVER_ID + '-popup';
		popupEl.innerHTML = [
			'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">',
			'  <span style="font-size:12px;color:rgba(255,255,255,0.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;">' + elementName.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>',
			'</div>',
			'<textarea id="' + HOVER_ID + '-textarea" rows="2" placeholder="What should change?" style="',
			'  width:100%;box-sizing:border-box;padding:8px 10px;font-size:13px;font-family:inherit;',
			'  background:rgba(255,255,255,0.05);color:#fff;border:1px solid rgba(255,255,255,0.15);',
			'  border-radius:8px;resize:none;outline:none;"></textarea>',
			'<div style="display:flex;justify-content:flex-end;gap:6px;margin-top:10px;">',
			'  <button id="' + HOVER_ID + '-cancel" style="',
			'    padding:6px 14px;font-size:12px;font-weight:500;border-radius:16px;border:none;',
			'    background:transparent;color:rgba(255,255,255,0.5);cursor:pointer;font-family:inherit;">Cancel</button>',
			'  <button id="' + HOVER_ID + '-submit" style="',
			'    padding:6px 14px;font-size:12px;font-weight:500;border-radius:16px;border:none;',
			'    background:#0078d4;color:#fff;cursor:pointer;opacity:0.4;font-family:inherit;">Add</button>',
			'</div>',
		].join('');

		Object.assign(popupEl.style, {
			position: 'fixed',
			left: Math.max(150, Math.min(x, window.innerWidth - 150)) + 'px',
			top: Math.min(y, window.innerHeight - 180) + 'px',
			transform: 'translateX(-50%)',
			width: '280px',
			padding: '12px 16px 14px',
			background: '#1a1a1a',
			borderRadius: '16px',
			boxShadow: '0 4px 24px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.08)',
			zIndex: '2147483647',
			fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
			animation: '__ann_popupIn 0.2s ease-out forwards',
		});

		// Add popup animation
		let animStyle = document.getElementById(HOVER_ID + '-popup-anim');
		if (!animStyle) {
			animStyle = document.createElement('style');
			animStyle.id = HOVER_ID + '-popup-anim';
			animStyle.textContent = [
				'@keyframes __ann_popupIn {',
				'  from { opacity: 0; transform: translateX(-50%) scale(0.95) translateY(4px); }',
				'  to { opacity: 1; transform: translateX(-50%) scale(1) translateY(0); }',
				'}',
			].join('\\n');
			document.head.appendChild(animStyle);
		}

		document.body.appendChild(popupEl);

		const textarea = document.getElementById(HOVER_ID + '-textarea');
		const submitBtn = document.getElementById(HOVER_ID + '-submit');
		const cancelBtn = document.getElementById(HOVER_ID + '-cancel');

		// Focus textarea
		setTimeout(() => textarea?.focus(), 50);

		// Enable/disable submit based on content
		textarea?.addEventListener('input', () => {
			if (submitBtn) {
				submitBtn.style.opacity = textarea.value.trim() ? '1' : '0.4';
			}
		});

		// Focus styling
		textarea?.addEventListener('focus', () => {
			if (textarea) textarea.style.borderColor = '#0078d4';
		});
		textarea?.addEventListener('blur', () => {
			if (textarea) textarea.style.borderColor = 'rgba(255,255,255,0.15)';
		});

		// Submit
		submitBtn?.addEventListener('click', () => {
			const comment = textarea?.value?.trim();
			if (comment && clickResolve) {
				clickResolve({ comment });
				clickResolve = null;
			}
			removePopup();
			active = true; // Resume hover
		});

		// Cancel
		cancelBtn?.addEventListener('click', () => {
			if (clickResolve) {
				clickResolve({ comment: null });
				clickResolve = null;
			}
			removePopup();
			active = true; // Resume hover
		});

		// Submit on Cmd/Ctrl+Enter
		textarea?.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				submitBtn?.click();
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				cancelBtn?.click();
			}
		});
	}

	function removePopup() {
		if (popupEl) {
			popupEl.remove();
			popupEl = null;
		}
	}

	function activate() {
		ensureStyles();
		ensureElements();
		active = true;
		document.addEventListener('mousemove', onMouseMove, true);
		document.addEventListener('click', onClick, true);
	}

	function deactivate() {
		active = false;
		removePopup();
		document.removeEventListener('mousemove', onMouseMove, true);
		document.removeEventListener('click', onClick, true);
		if (highlight) highlight.classList.remove('visible');
		if (tooltip) tooltip.classList.remove('visible');
	}

	function waitForClick() {
		return new Promise(resolve => {
			clickResolve = resolve;
		});
	}

	function remove() {
		deactivate();
		if (highlight) { highlight.remove(); highlight = null; }
		if (tooltip) { tooltip.remove(); tooltip = null; }
		const style = document.getElementById(STYLE_ID);
		if (style) style.remove();
		const animStyle = document.getElementById(HOVER_ID + '-popup-anim');
		if (animStyle) animStyle.remove();
		delete window.__annotationHover;
	}

	window.__annotationHover = {
		activate: activate,
		deactivate: deactivate,
		waitForClick: waitForClick,
		getClickedElement: function() { return clickedElement; },
		remove: remove
	};
})();
`;

/**
 * Manages annotation markers injected into the browser page via Playwright.
 */
export class BrowserAnnotationMarkers extends Disposable {

	private _markersInjected = false;
	private _hoverInjected = false;

	constructor(
		private readonly _browserId: string,
		private readonly _playwrightService: IPlaywrightService,
		private readonly _logService: ILogService,
	) {
		super();
	}

	/**
	 * Inject the marker script and update markers for the given annotations.
	 */
	async updateMarkers(annotations: readonly IBrowserAnnotation[]): Promise<void> {
		try {
			await this._ensureTracked();
			await this._ensureMarkersInjected();

			const serialized = annotations.map(a => ({
				index: a.index,
				comment: a.comment,
				bounds: a.bounds,
				ancestors: a.ancestors,
				attributes: a.attributes,
			}));

			await this._playwrightService.invokeFunctionRaw(
				this._browserId,
				`async (page, annotations) => {
					await page.evaluate((data) => {
						window.__annotationMarkers?.update(data);
					}, annotations);
				}`,
				serialized,
			);
		} catch (e) {
			this._logService.warn('BrowserAnnotationMarkers: Failed to update markers', e);
		}
	}

	/**
	 * Clear all markers from the page.
	 */
	async clearMarkers(): Promise<void> {
		try {
			if (this._markersInjected) {
				await this._playwrightService.invokeFunctionRaw(
					this._browserId,
					`async (page) => {
						await page.evaluate(() => {
							window.__annotationMarkers?.clear();
						});
					}`,
				);
			}
		} catch (e) {
			this._logService.warn('BrowserAnnotationMarkers: Failed to clear markers', e);
		}
	}

	/**
	 * Remove the marker system entirely from the page.
	 */
	async removeAll(): Promise<void> {
		try {
			if (this._markersInjected) {
				await this._playwrightService.invokeFunctionRaw(
					this._browserId,
					`async (page) => {
						await page.evaluate(() => {
							window.__annotationMarkers?.remove();
						});
					}`,
				);
				this._markersInjected = false;
			}
		} catch (e) {
			this._logService.warn('BrowserAnnotationMarkers: Failed to remove markers', e);
		}
	}

	// -- Hover Overlay ---------------------------------------------------

	/**
	 * Activate the custom hover overlay in the page.
	 * Replaces CDP Overlay.setInspectMode with a mini-tool-style
	 * highlight box + element name tooltip.
	 */
	async activateHoverOverlay(): Promise<void> {
		try {
			await this._ensureTracked();
			await this._ensureHoverInjected();
			await this._playwrightService.invokeFunctionRaw(
				this._browserId,
				`async (page) => {
					await page.evaluate(() => {
						window.__annotationHover?.activate();
					});
				}`,
			);
		} catch (e) {
			this._logService.warn('BrowserAnnotationMarkers: Failed to activate hover overlay', e);
		}
	}

	/**
	 * Deactivate the hover overlay.
	 */
	async deactivateHoverOverlay(): Promise<void> {
		try {
			if (this._hoverInjected) {
				await this._playwrightService.invokeFunctionRaw(
					this._browserId,
					`async (page) => {
						await page.evaluate(() => {
							window.__annotationHover?.deactivate();
						});
					}`,
				);
			}
		} catch (e) {
			this._logService.warn('BrowserAnnotationMarkers: Failed to deactivate hover overlay', e);
		}
	}

	/**
	 * Wait for the user to click an element and submit a comment via the in-page popup.
	 * Returns element data + comment, or undefined if cancelled.
	 */
	async waitForAnnotation(token: CancellationToken): Promise<IAnnotationClickResult | undefined> {
		try {
			await this._ensureTracked();
			await this._ensureHoverInjected();

			// waitForClick now resolves after the user submits or cancels the popup.
			// It returns { comment: string } on submit, or { comment: null } on cancel.
			const result = await Promise.race([
				this._playwrightService.invokeFunctionRaw<{ comment: string | null }>(
					this._browserId,
					`async (page) => {
						return await page.evaluate(() => {
							return window.__annotationHover?.waitForClick();
						});
					}`,
				),
				new Promise<undefined>(resolve => {
					token.onCancellationRequested(() => resolve(undefined));
				}),
			]);

			if (!result || token.isCancellationRequested || !result.comment) {
				return undefined;
			}

			// Now extract rich element data for the clicked element.
			const elementData = await this._playwrightService.invokeFunctionRaw<IElementData | null>(
				this._browserId,
				`async (page) => {
					const data = await page.evaluate(() => {
						const el = window.__annotationHover?.getClickedElement();
						if (!el) return null;

						const rect = el.getBoundingClientRect();
						const outerHTML = el.outerHTML;
						const innerText = el.textContent?.trim() || '';

						// Build ancestors
						const ancestors = [];
						let current = el;
						while (current && current !== document.documentElement) {
							const classNames = current.className && typeof current.className === 'string'
								? current.className.split(/\\s+/).filter(c => c)
								: [];
							ancestors.push({
								tagName: current.tagName.toLowerCase(),
								id: current.id || undefined,
								classNames: classNames.length > 0 ? classNames : undefined,
							});
							current = current.parentElement;
						}

						// Build attributes
						const attributes = {};
						for (const attr of el.attributes) {
							attributes[attr.name] = attr.value;
						}

						// Capture computed styles (matching the richness of Add Element to Chat)
						const computed = window.getComputedStyle(el);
						const styleProps = [
							'display', 'position', 'width', 'height', 'margin', 'padding',
							'border', 'background', 'background-color', 'color', 'font-family',
							'font-size', 'font-weight', 'line-height', 'text-align', 'text-decoration',
							'opacity', 'visibility', 'overflow', 'z-index', 'flex', 'flex-direction',
							'justify-content', 'align-items', 'gap', 'grid-template-columns',
							'grid-template-rows', 'box-shadow', 'border-radius', 'cursor',
							'transition', 'transform', 'max-width', 'max-height', 'min-width', 'min-height',
						];
						const computedStyles = {};
						for (const prop of styleProps) {
							const val = computed.getPropertyValue(prop);
							if (val && val !== 'none' && val !== 'normal' && val !== 'auto' && val !== '0px' && val !== 'rgba(0, 0, 0, 0)') {
								computedStyles[prop] = val;
							}
						}

						// Build full computed style string
						const allStyles = [];
						for (let i = 0; i < computed.length; i++) {
							const name = computed[i];
							allStyles.push(name + ': ' + computed.getPropertyValue(name));
						}

						return {
							outerHTML: outerHTML.length > 5000 ? outerHTML.slice(0, 5000) + '...' : outerHTML,
							computedStyle: allStyles.join(';\\n'),
							bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
							ancestors: ancestors.reverse(),
							attributes,
							computedStyles,
							dimensions: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
							innerText: innerText.slice(0, 500),
						};
					});
					return data;
				}`,
			);

			if (!elementData) {
				return undefined;
			}

			return { elementData, comment: result.comment };
		} catch (e) {
			if (!token.isCancellationRequested) {
				this._logService.warn('BrowserAnnotationMarkers: Error during annotation', e);
			}
			return undefined;
		}
	}

	/**
	 * Called when page navigates — reset injection state so we re-inject on next update.
	 */
	resetInjectionState(): void {
		this._markersInjected = false;
		this._hoverInjected = false;
	}

	private async _ensureTracked(): Promise<void> {
		const isTracked = await this._playwrightService.isPageTracked(this._browserId);
		if (!isTracked) {
			await this._playwrightService.startTrackingPage(this._browserId);
		}
	}

	private async _ensureMarkersInjected(): Promise<void> {
		if (!this._markersInjected) {
			await this._injectScript(MARKER_INJECTION_SCRIPT);
			this._markersInjected = true;
		}
	}

	private async _ensureHoverInjected(): Promise<void> {
		if (!this._hoverInjected) {
			await this._injectScript(HOVER_OVERLAY_SCRIPT);
			this._hoverInjected = true;
		}
	}

	private async _injectScript(script: string): Promise<void> {
		await this._playwrightService.invokeFunctionRaw(
			this._browserId,
			`async (page, script) => {
				await page.evaluate((s) => {
					const fn = new Function(s);
					fn();
				}, script);
			}`,
			script,
		);
	}
}
