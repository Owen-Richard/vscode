/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IBrowserViewCDPService } from '../common/browserView.js';
import { IBrowserAnnotation } from '../common/browserAnnotation.js';
import { ILogService } from '../../../../platform/log/common/log.js';

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
 * Manages annotation markers injected into the browser page via CDP.
 */
export class BrowserAnnotationMarkers extends Disposable {

	private _cdpGroupId: string | undefined;
	private _injected = false;

	constructor(
		private readonly _browserId: string,
		private readonly _cdpService: IBrowserViewCDPService,
		private readonly _logService: ILogService,
	) {
		super();
	}

	/**
	 * Inject the marker script and update markers for the given annotations.
	 */
	async updateMarkers(annotations: readonly IBrowserAnnotation[]): Promise<void> {
		try {
			await this._ensureCdpGroup();
			await this._ensureInjected();

			const serialized = annotations.map(a => ({
				index: a.index,
				comment: a.comment,
				bounds: a.bounds,
				ancestors: a.ancestors,
				attributes: a.attributes,
			}));

			await this._evaluate(`window.__annotationMarkers?.update(${JSON.stringify(serialized)})`);
		} catch (e) {
			this._logService.warn('BrowserAnnotationMarkers: Failed to update markers', e);
		}
	}

	/**
	 * Clear all markers from the page.
	 */
	async clearMarkers(): Promise<void> {
		try {
			if (this._injected) {
				await this._evaluate('window.__annotationMarkers?.clear()');
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
			if (this._injected) {
				await this._evaluate('window.__annotationMarkers?.remove()');
				this._injected = false;
			}
		} catch (e) {
			this._logService.warn('BrowserAnnotationMarkers: Failed to remove markers', e);
		}
	}

	/**
	 * Called when page navigates — reset injection state so we re-inject on next update.
	 */
	resetInjectionState(): void {
		this._injected = false;
	}

	override dispose(): void {
		if (this._cdpGroupId) {
			this._cdpService.destroySessionGroup(this._cdpGroupId).catch(() => { });
			this._cdpGroupId = undefined;
		}
		this._injected = false;
		super.dispose();
	}

	private async _ensureCdpGroup(): Promise<void> {
		if (!this._cdpGroupId) {
			this._cdpGroupId = await this._cdpService.createSessionGroup(this._browserId);
		}
	}

	private async _ensureInjected(): Promise<void> {
		if (!this._injected) {
			await this._evaluate(MARKER_INJECTION_SCRIPT);
			this._injected = true;
		}
	}

	private async _evaluate(expression: string): Promise<void> {
		if (!this._cdpGroupId) {
			return;
		}

		const id = Math.floor(Math.random() * 1e9);
		await this._cdpService.sendCDPMessage(this._cdpGroupId, {
			id,
			method: 'Runtime.evaluate',
			params: {
				expression,
				returnByValue: true,
				awaitPromise: false,
			},
		});
	}
}
