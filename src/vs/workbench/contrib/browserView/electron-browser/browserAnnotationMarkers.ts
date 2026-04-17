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
	readonly selectedText?: string;
	readonly mode?: string;
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
				box-shadow: 0 2px 6px rgba(0,0,0,0.2), inset 0 0 0 1px rgba(0,0,0,0.04);
				pointer-events: auto;
				cursor: pointer;
				transform: translate(-50%, -50%);
				transition: transform 0.15s ease;
				user-select: none;
				-webkit-user-select: none;
				z-index: 1;
			}
			.\${CONTAINER_ID}-marker:hover {
				transform: translate(-50%, -50%) scale(1.1);
				z-index: 2;
			}
			.\${CONTAINER_ID}-highlight {
				position: absolute;
				border: 2px solid rgba(0, 120, 212, 0.6);
				background: rgba(0, 120, 212, 0.05);
				border-radius: 4px;
				pointer-events: none;
				opacity: 0;
				transition: opacity 0.15s ease;
			}
			.\${CONTAINER_ID}-highlight.vis {
				opacity: 1;
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
		_currentAnnotations = annotations;
		renderMarkers();
		if (!_resizeListenerActive) {
			window.addEventListener('resize', renderMarkers);
			window.addEventListener('scroll', renderMarkers);
			_resizeListenerActive = true;
		}
	}

	var _currentAnnotations = [];
	var _resizeListenerActive = false;

	function renderMarkers() {
		var annotations = _currentAnnotations;
		var container = ensureContainer();
		container.innerHTML = '';

		for (const annotation of annotations) {
			const element = findElement(annotation);
			if (!element) continue;

			const rect = element.getBoundingClientRect();
			const scrollX = window.scrollX;
			const scrollY = window.scrollY;

			// Highlight outline (hidden by default, shown on marker hover)
			const hl = document.createElement('div');
			hl.className = CONTAINER_ID + '-highlight';
			hl.style.left = (rect.left + scrollX - 2) + 'px';
			hl.style.top = (rect.top + scrollY - 2) + 'px';
			hl.style.width = (rect.width + 4) + 'px';
			hl.style.height = (rect.height + 4) + 'px';
			container.appendChild(hl);

			// Numbered marker badge
			const marker = document.createElement('div');
			marker.className = CONTAINER_ID + '-marker';
			marker.textContent = String(annotation.index);
			marker.title = annotation.comment;
			marker.style.left = (rect.right + scrollX) + 'px';
			marker.style.top = (rect.top + scrollY) + 'px';

			// Show outline on marker hover
			marker.addEventListener('mouseenter', function() { hl.classList.add('vis'); });
			marker.addEventListener('mouseleave', function() { hl.classList.remove('vis'); });

			container.appendChild(marker);
		}
	}

	function clearMarkers() {
		_currentAnnotations = [];
		const container = document.getElementById(CONTAINER_ID);
		if (container) {
			container.innerHTML = '';
		}
	}

	function removeAll() {
		_currentAnnotations = [];
		if (_resizeListenerActive) {
			window.removeEventListener('resize', renderMarkers);
			window.removeEventListener('scroll', renderMarkers);
			_resizeListenerActive = false;
		}
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
 * custom hover highlighting, element selection, text selection, group selection
 * (Cmd/Ctrl+Shift+Click), and area/drag selection — matching the mini-tool
 * agentation prototype's visual behavior.
 *
 * Returns from waitForClick():
 * { comment, selectedText?, mode: 'single'|'group'|'area'|'text', elementBounds? }
 */
const HOVER_OVERLAY_SCRIPT = `
(function() {
if (window.__annotationHover) return;

const HOVER_ID = '__vscode-annotation-hover';
const STYLE_ID = '__vscode-annotation-hover-style';
const DRAG_THRESHOLD = 5;
const ELEMENT_UPDATE_THROTTLE = 50;

function ensureStyles() {
if (document.getElementById(STYLE_ID)) return;
const s = document.createElement('style');
s.id = STYLE_ID;
s.textContent = [
'.' + HOVER_ID + '-hl { position:fixed; border:2px solid rgba(0,120,212,0.5); border-radius:4px;',
'  background:rgba(0,120,212,0.04); pointer-events:none; box-sizing:border-box; z-index:2147483645;',
'  display:none; transition:top .06s ease-out,left .06s ease-out,width .06s ease-out,height .06s ease-out; }',
'.' + HOVER_ID + '-hl.vis { display:block; animation:__ah_in .12s ease-out forwards; }',
'@keyframes __ah_in { from{opacity:0;transform:scale(.98)} to{opacity:1;transform:scale(1)} }',
'.' + HOVER_ID + '-tt { position:fixed; font:500 11px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
'  color:#fff; background:rgba(0,0,0,.85); padding:4px 8px; border-radius:6px; pointer-events:none;',
'  white-space:nowrap; max-width:280px; overflow:hidden; text-overflow:ellipsis; z-index:2147483645; display:none; }',
'.' + HOVER_ID + '-tt.vis { display:block; animation:__ah_tt .1s ease-out forwards; }',
'@keyframes __ah_tt { from{opacity:0;transform:scale(.95) translateY(4px)} to{opacity:1;transform:scale(1) translateY(0)} }',
'.' + HOVER_ID + '-drag { position:fixed; border:2px dashed rgba(0,120,212,0.8); border-radius:4px;',
'  background:rgba(0,120,212,0.1); pointer-events:none; z-index:2147483645; display:none; }',
'.' + HOVER_ID + '-drag.vis { display:block; }',
'.' + HOVER_ID + '-ghl { position:fixed; border:2px solid rgba(0,120,212,0.7); border-radius:3px;',
'  background:rgba(0,120,212,0.12); pointer-events:none; z-index:2147483644; }',
'@keyframes __ah_pop { from{opacity:0;transform:translateX(-50%) scale(.95) translateY(4px)}',
'  to{opacity:1;transform:translateX(-50%) scale(1) translateY(0)} }',
'@keyframes __ah_shake { 0%,100%{transform:translateX(-50%)} 25%{transform:translateX(calc(-50% + 3px))}',
'  75%{transform:translateX(calc(-50% - 3px))} }',
].join('\\n');
document.head.appendChild(s);
}

function identify(el) {
const tag = el.tagName.toLowerCase();
if (tag === 'button') { const t = el.textContent?.trim(); const a = el.getAttribute('aria-label'); return a ? 'button ['+a+']' : t ? 'button "'+t.slice(0,25)+'"' : 'button'; }
if (tag === 'a') { const t = el.textContent?.trim(); return t ? 'link "'+t.slice(0,25)+'"' : 'link'; }
if (tag === 'input') { const ph = el.getAttribute('placeholder'); const n = el.getAttribute('name'); return ph ? 'input "'+ph+'"' : n ? 'input ['+n+']' : (el.getAttribute('type')||'text')+' input'; }
if (['h1','h2','h3','h4','h5','h6'].includes(tag)) { const t = el.textContent?.trim(); return t ? tag+' "'+t.slice(0,35)+'"' : tag; }
if (tag === 'img') { const a = el.getAttribute('alt'); return a ? 'image "'+a.slice(0,30)+'"' : 'image'; }
if (tag === 'p') { const t = el.textContent?.trim(); return t ? 'paragraph: "'+t.slice(0,40)+(t.length>40?'...':'')+'"' : 'paragraph'; }
if (tag === 'span' || tag === 'label') { const t = el.textContent?.trim(); if (t && t.length < 40) return '"'+t+'"'; return tag; }
if (['div','section','article','nav','header','footer','aside','main'].includes(tag)) {
const role = el.getAttribute('role'); const a = el.getAttribute('aria-label');
if (a) return tag+' ['+a+']'; if (role) return role;
const cn = el.className; if (typeof cn === 'string' && cn) {
const w = cn.split(/[\\s_-]+/).map(c=>c.replace(/[A-Z0-9]{5,}.*$/,'')).filter(c=>c.length>2&&!/^[a-z]{1,2}$/.test(c)).slice(0,2);
if (w.length) return w.join(' ');
}
return tag === 'div' ? 'container' : tag;
}
return tag;
}

function deepElement(x, y) {
let el = document.elementFromPoint(x, y);
if (!el) return null;
while (el?.shadowRoot) { const d = el.shadowRoot.elementFromPoint(x, y); if (!d || d === el) break; el = d; }
return el;
}

const TEXT_TAGS = new Set(['P','SPAN','H1','H2','H3','H4','H5','H6','LI','TD','TH','LABEL','BLOCKQUOTE',
'FIGCAPTION','CAPTION','PRE','CODE','EM','STRONG','B','I','U','S','A','TIME','ADDRESS','CITE','Q','MARK','SMALL','SUB','SUP']);
const MEANINGFUL_SELECTOR = 'button,a,input,img,p,h1,h2,h3,h4,h5,h6,li,label,td,th,section,article,aside,nav';

function isOurs(el) {
if (!el) return false;
if (el.id && el.id.startsWith('__vscode-annotation')) return true;
if (el.className && typeof el.className === 'string' && el.className.indexOf('__vscode-annotation') >= 0) return true;
if (el.closest && el.closest('[id^="__vscode-annotation"]')) return true;
return false;
}
function isSkip(el) { return !el || isOurs(el) || el === document.body || el === document.documentElement; }

let highlight = null, tooltip = null, dragRect = null;
let groupHighlights = [];
let active = false, clickResolve = null, clickedElement = null;
let isDragging = false, mouseDownPos = null, dragStart = null;
let groupElements = [];
let lastElementUpdate = 0;
let scrollTimeout = null, isScrolling = false;

function ensureElements() {
if (!highlight) { highlight = document.createElement('div'); highlight.className = HOVER_ID + '-hl'; document.body.appendChild(highlight); }
if (!tooltip) { tooltip = document.createElement('div'); tooltip.className = HOVER_ID + '-tt'; document.body.appendChild(tooltip); }
if (!dragRect) { dragRect = document.createElement('div'); dragRect.className = HOVER_ID + '-drag'; document.body.appendChild(dragRect); }
}

function onMouseMove(e) {
if (!active && !isDragging) return;
if (mouseDownPos || isDragging) { onDragMove(e); return; }
if (isScrolling) { highlight.classList.remove('vis'); tooltip.classList.remove('vis'); return; }
const el = deepElement(e.clientX, e.clientY);
if (isSkip(el)) { highlight.classList.remove('vis'); tooltip.classList.remove('vis'); return; }
const rect = el.getBoundingClientRect();
highlight.style.left = rect.left+'px'; highlight.style.top = rect.top+'px';
highlight.style.width = rect.width+'px'; highlight.style.height = rect.height+'px';
highlight.classList.add('vis');
tooltip.textContent = identify(el);
tooltip.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - 200))+'px';
tooltip.style.top = Math.max(e.clientY - 32, 8)+'px';
tooltip.classList.add('vis');
}

function onScroll() {
isScrolling = true;
if (scrollTimeout) clearTimeout(scrollTimeout);
scrollTimeout = setTimeout(function() { isScrolling = false; }, 150);
}

function onMouseDown(e) {
if (!active) return;
const el = deepElement(e.clientX, e.clientY);
if (isOurs(el)) return;
if (el && TEXT_TAGS.has(el.tagName)) return;
e.preventDefault();
mouseDownPos = { x: e.clientX, y: e.clientY };
}

function onDragMove(e) {
if (!mouseDownPos) return;
const dx = e.clientX - mouseDownPos.x, dy = e.clientY - mouseDownPos.y;
if (!isDragging && (dx*dx + dy*dy) >= DRAG_THRESHOLD * DRAG_THRESHOLD) {
isDragging = true; dragStart = mouseDownPos;
highlight.classList.remove('vis'); tooltip.classList.remove('vis');
}
if (!isDragging || !dragStart) return;
e.preventDefault();
const left = Math.min(dragStart.x, e.clientX), top = Math.min(dragStart.y, e.clientY);
const w = Math.abs(e.clientX - dragStart.x), h = Math.abs(e.clientY - dragStart.y);
dragRect.style.left = left+'px'; dragRect.style.top = top+'px';
dragRect.style.width = w+'px'; dragRect.style.height = h+'px';
dragRect.classList.add('vis');
const now = Date.now();
if (now - lastElementUpdate < ELEMENT_UPDATE_THROTTLE) return;
lastElementUpdate = now;
highlightAreaElements(left, top, left + w, top + h);
}

function highlightAreaElements(left, top, right, bottom) {
clearGroupHighlights();
document.querySelectorAll(MEANINGFUL_SELECTOR).forEach(function(el) {
if (isOurs(el)) return;
const r = el.getBoundingClientRect();
if (r.width < 10 || r.height < 10) return;
if (r.width > window.innerWidth * 0.8 && r.height > window.innerHeight * 0.5) return;
if (r.left < right && r.right > left && r.top < bottom && r.bottom > top) {
const h = document.createElement('div'); h.className = HOVER_ID + '-ghl';
h.style.left = r.left+'px'; h.style.top = r.top+'px';
h.style.width = r.width+'px'; h.style.height = r.height+'px';
document.body.appendChild(h); groupHighlights.push(h);
}
});
}

function clearGroupHighlights() { for (const h of groupHighlights) h.remove(); groupHighlights = []; }

function onMouseUp(e) {
if (!active) return;
const wasDragging = isDragging;
if (wasDragging && dragStart) {
const left = Math.min(dragStart.x, e.clientX), top = Math.min(dragStart.y, e.clientY);
const right = Math.max(dragStart.x, e.clientX), bottom = Math.max(dragStart.y, e.clientY);
const matches = [];
document.querySelectorAll(MEANINGFUL_SELECTOR).forEach(function(el) {
if (isOurs(el)) return;
const r = el.getBoundingClientRect();
if (r.width < 10 || r.height < 10) return;
if (r.width > window.innerWidth * 0.8 && r.height > window.innerHeight * 0.5) return;
if (r.left < right && r.right > left && r.top < bottom && r.bottom > top) {
matches.push({ el: el, rect: r });
}
});
var final = matches.filter(function(m) { return !matches.some(function(o) { return o.el !== m.el && m.el.contains(o.el); }); });
dragRect.classList.remove('vis'); clearGroupHighlights();
isDragging = false; dragStart = null; mouseDownPos = null;
if (final.length > 0) {
active = false;
var bounds = final.map(function(f) { return { x:f.rect.x, y:f.rect.y, width:f.rect.width, height:f.rect.height }; });
var names = final.map(function(f) { return identify(f.el); }).slice(0, 5);
var label = final.length + ' element' + (final.length > 1 ? 's' : '') + ': ' + names.join(', ');
clickedElement = final[0].el;
var uy2 = Math.max.apply(null, final.map(function(f) { return f.rect.bottom; }));
var cx = (Math.min.apply(null,final.map(function(f){return f.rect.x;})) + Math.max.apply(null,final.map(function(f){return f.rect.right;})))/2;
showPopup(label, cx, uy2 + 12, 'area', bounds);
}
return;
}
isDragging = false; dragStart = null; mouseDownPos = null;
}

function onClick(e) {
if (!active) return;
var el = deepElement(e.clientX, e.clientY);
if (isOurs(el)) return;
e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();

if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
if (!el || isSkip(el)) return;
var idx = -1;
for (var i = 0; i < groupElements.length; i++) { if (groupElements[i].el === el) { idx = i; break; } }
if (idx >= 0) { groupElements.splice(idx, 1); } else {
groupElements.push({ el: el, rect: el.getBoundingClientRect(), name: identify(el) });
}
renderGroupHighlights();
return;
}

if (groupElements.length > 0) { finalizeGroup(e.clientX, e.clientY, el); return; }
if (!el || isSkip(el)) return;

var sel = window.getSelection();
var selectedText = (sel && sel.toString().trim().length > 0) ? sel.toString().trim().slice(0, 500) : undefined;

var styles = getKeyStyles(el);

active = false; clickedElement = el;
highlight.classList.remove('vis'); tooltip.classList.remove('vis');
var name = identify(el);
var rect = el.getBoundingClientRect();
var mode = selectedText ? 'text' : 'single';
showPopup(name, e.clientX, rect.bottom + 12, mode, undefined, selectedText, styles);
}

function getKeyStyles(el) {
var cs = window.getComputedStyle(el);
var props = ['color','font-size','font-weight','font-family','line-height',
'background-color','border','border-radius','padding','margin',
'display','position','width','height','opacity'];
var result = [];
for (var i = 0; i < props.length; i++) {
var v = cs.getPropertyValue(props[i]);
if (v && v !== 'none' && v !== 'normal' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)' && v !== 'auto') {
result.push(props[i] + ': ' + v + ';');
}
}
return result;
}

function renderGroupHighlights() {
clearGroupHighlights();
for (var i = 0; i < groupElements.length; i++) {
var r = groupElements[i].el.getBoundingClientRect();
var h = document.createElement('div'); h.className = HOVER_ID + '-ghl';
h.style.left = r.left+'px'; h.style.top = r.top+'px';
h.style.width = r.width+'px'; h.style.height = r.height+'px';
document.body.appendChild(h); groupHighlights.push(h);
}
}

function finalizeGroup(cx, cy, lastEl) {
active = false; clearGroupHighlights();
if (lastEl && !isSkip(lastEl)) {
var found = false;
for (var i = 0; i < groupElements.length; i++) { if (groupElements[i].el === lastEl) { found = true; break; } }
if (!found) groupElements.push({ el: lastEl, rect: lastEl.getBoundingClientRect(), name: identify(lastEl) });
}
var bounds = groupElements.map(function(g) { var r = g.el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; });
var label = groupElements.length + ' element' + (groupElements.length > 1 ? 's' : '') + ': ' + groupElements.map(function(g){return g.name;}).slice(0,5).join(', ');
clickedElement = groupElements[0] ? groupElements[0].el : null;
highlight.classList.remove('vis'); tooltip.classList.remove('vis');
var uy2 = 0; for (var i = 0; i < groupElements.length; i++) { var b = groupElements[i].el.getBoundingClientRect().bottom; if (b > uy2) uy2 = b; }
showPopup(label, cx, uy2 + 12, 'group', bounds);
}

function onKeyUp(e) {
if (!active || groupElements.length === 0) return;
if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift') {
if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
var r0 = groupElements[0].el.getBoundingClientRect();
finalizeGroup(r0.left + r0.width/2, r0.bottom, null);
}
}
}

var popupEl = null, popupMode = 'single', popupBounds = null, popupSelectedText = null;

function showPopup(elementName, x, y, mode, bounds, selectedText, styles) {
removePopup();
popupMode = mode || 'single';
popupBounds = bounds;
popupSelectedText = selectedText;

popupEl = document.createElement('div');
popupEl.id = HOVER_ID + '-popup';
var headerText = elementName.replace(/</g,'&lt;').replace(/>/g,'&gt;');
var quoteHtml = selectedText ? '<div style="font-size:11px;font-style:italic;color:rgba(204,204,204,0.6);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.4;">&ldquo;' + selectedText.slice(0,60).replace(/</g,'&lt;') + (selectedText.length>60?'...':'') + '&rdquo;</div>' : '';

var stylesHtml = '';
if (styles && styles.length > 0) {
stylesHtml = [
'<div style="margin-bottom:6px;">',
'  <div id="'+HOVER_ID+'-styles-toggle" style="cursor:pointer;font-size:11px;color:rgba(204,204,204,0.6);user-select:none;display:flex;align-items:center;gap:4px;">',
'    <span id="'+HOVER_ID+'-styles-arrow" style="font-size:9px;transition:transform 0.15s;">&#9654;</span>',
'    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + headerText + '</span>',
'  </div>',
'  <div id="'+HOVER_ID+'-styles-body" style="display:none;margin-top:4px;padding:6px 8px;background:rgba(0,0,0,0.2);border-radius:4px;font-family:Consolas,\\'Courier New\\',monospace;font-size:11px;line-height:1.5;color:#c586c0;overflow-x:auto;max-height:120px;overflow-y:auto;">',
styles.map(function(s) {
var parts = s.split(':');
var prop = parts[0];
var val = parts.slice(1).join(':');
return '<div><span style="color:#9cdcfe;">' + prop + '</span>:<span style="color:#ce9178;">' + val + '</span></div>';
}).join(''),
'  </div>',
'</div>',
].join('');
}

popupEl.innerHTML = [
stylesHtml ? '' : '<div style="display:flex;align-items:center;margin-bottom:6px;"><span style="font-size:11px;line-height:1.4;color:rgba(204,204,204,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:248px;">' + headerText + '</span></div>',
stylesHtml,
quoteHtml,
'<textarea id="' + HOVER_ID + '-ta" rows="2" placeholder="What should change?" style="',
'  width:100%;box-sizing:border-box;padding:4px 6px;font-size:13px;line-height:1.4;font-family:inherit;',
'  background:#3c3c3c;color:#ccc;border:1px solid #3c3c3c;',
'  border-radius:4px;resize:none;outline:none;"></textarea>',
'<div style="display:flex;justify-content:flex-end;gap:4px;margin-top:8px;">',
'  <button id="'+HOVER_ID+'-cancel" style="padding:4px 8px;font-size:12px;line-height:16px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#ccc;cursor:pointer;font-family:inherit;">Cancel</button>',
'  <button id="'+HOVER_ID+'-submit" style="padding:4px 8px;font-size:12px;line-height:16px;border-radius:4px;border:1px solid transparent;background:#0078d4;color:#fff;cursor:pointer;opacity:0.4;font-family:inherit;">Add</button>',
'</div>',
].join('');

Object.assign(popupEl.style, {
position:'fixed', left:Math.max(140,Math.min(x,window.innerWidth-140))+'px',
top:Math.min(y,window.innerHeight-180)+'px', transform:'translateX(-50%)',
width:'264px', padding:'8px', background:'#252526', borderRadius:'8px',
border:'1px solid #454545',
boxShadow:'0 0 20px rgba(0,0,0,0.15)',
zIndex:'2147483647',
fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe WPC","Segoe UI",system-ui,"Ubuntu","Droid Sans",sans-serif',
fontSize:'13px', lineHeight:'1.4em',
animation:'__ah_pop 0.2s ease-out forwards',
});
document.body.appendChild(popupEl);

// Accordion toggle for computed styles
var stToggle = document.getElementById(HOVER_ID+'-styles-toggle');
var stBody = document.getElementById(HOVER_ID+'-styles-body');
var stArrow = document.getElementById(HOVER_ID+'-styles-arrow');
if (stToggle && stBody && stArrow) {
stToggle.addEventListener('click', function() {
var open = stBody.style.display !== 'none';
stBody.style.display = open ? 'none' : 'block';
stArrow.style.transform = open ? '' : 'rotate(90deg)';
});
}

var ta = document.getElementById(HOVER_ID+'-ta');
var sub = document.getElementById(HOVER_ID+'-submit');
var can = document.getElementById(HOVER_ID+'-cancel');
setTimeout(function() { if(ta) ta.focus(); }, 50);
if(ta) ta.addEventListener('input', function() { if (sub) sub.style.opacity = ta.value.trim() ? '1' : '0.4'; });
if(ta) ta.addEventListener('focus', function() { ta.style.borderColor = '#007acc'; });
if(ta) ta.addEventListener('blur', function() { ta.style.borderColor = '#3c3c3c'; });

if(sub) sub.addEventListener('click', function() {
var comment = ta ? ta.value.trim() : '';
if (!comment) { if(popupEl) { popupEl.style.animation = '__ah_shake 0.25s ease-in-out'; setTimeout(function(){if(popupEl)popupEl.style.animation='';},300); } return; }
resolveClick(comment);
});
if(can) can.addEventListener('click', function() { resolveClick(null); });
if(ta) ta.addEventListener('keydown', function(e) {
if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if(sub) sub.click(); }
if (e.key === 'Escape') { e.preventDefault(); if(can) can.click(); }
});
}

function resolveClick(comment) {
var result = { comment: comment, mode: popupMode, selectedText: popupSelectedText || undefined, elementBounds: popupBounds || undefined };
removePopup(); groupElements = [];
if (clickResolve) { clickResolve(result); clickResolve = null; }
active = true;
}

function removePopup() { if (popupEl) { popupEl.remove(); popupEl = null; } }

function activate() {
ensureStyles(); ensureElements();
active = true; isDragging = false; mouseDownPos = null; dragStart = null; groupElements = [];
document.addEventListener('mousemove', onMouseMove, true);
document.addEventListener('mousedown', onMouseDown, true);
document.addEventListener('mouseup', onMouseUp, true);
document.addEventListener('click', onClick, true);
document.addEventListener('keyup', onKeyUp, true);
window.addEventListener('scroll', onScroll, { passive: true });
}

function deactivate() {
active = false; isDragging = false; groupElements = [];
document.removeEventListener('mousemove', onMouseMove, true);
document.removeEventListener('mousedown', onMouseDown, true);
document.removeEventListener('mouseup', onMouseUp, true);
document.removeEventListener('click', onClick, true);
document.removeEventListener('keyup', onKeyUp, true);
window.removeEventListener('scroll', onScroll);
if (highlight) highlight.classList.remove('vis');
if (tooltip) tooltip.classList.remove('vis');
if (dragRect) dragRect.classList.remove('vis');
clearGroupHighlights(); removePopup();
}

function waitForClick() { return new Promise(function(resolve) { clickResolve = resolve; }); }

function remove() {
deactivate();
if (highlight) { highlight.remove(); highlight = null; }
if (tooltip) { tooltip.remove(); tooltip = null; }
if (dragRect) { dragRect.remove(); dragRect = null; }
var st = document.getElementById(STYLE_ID); if (st) st.remove();
delete window.__annotationHover;
}

window.__annotationHover = {
activate: activate, deactivate: deactivate, waitForClick: waitForClick, remove: remove,
getClickedElement: function() { return clickedElement; },
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
				this._playwrightService.invokeFunctionRaw<{ comment: string | null; mode?: string; selectedText?: string; elementBounds?: Array<{ x: number; y: number; width: number; height: number }> }>(
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

			const selectedText = (result as Record<string, unknown>).selectedText as string | undefined;
			const annotationMode = ((result as Record<string, unknown>).mode as string) || 'single';

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

			return { elementData, comment: result.comment, selectedText, mode: annotationMode };
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
