/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/browserAnnotationToolbar.css';

import { localize, localize2 } from '../../../../../nls.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { $, addDisposableListener } from '../../../../../base/browser/dom.js';
import { IContextKey, IContextKeyService, RawContextKey, ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IChatWidgetService } from '../../../chat/browser/chat.js';
import { IChatRequestVariableEntry } from '../../../chat/common/attachments/chatVariableEntries.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ChatContextKeys } from '../../../chat/common/actions/chatContextKeys.js';

import { BrowserEditor, BrowserEditorContribution, CONTEXT_BROWSER_HAS_URL, CONTEXT_BROWSER_HAS_ERROR } from '../browserEditor.js';
import { BROWSER_EDITOR_ACTIVE, BrowserActionCategory } from '../browserViewActions.js';
import { IBrowserViewCDPService, IBrowserViewModel } from '../../common/browserView.js';
import { IBrowserAnnotation, BrowserAnnotationDetailLevel, createBrowserAnnotation } from '../../common/browserAnnotation.js';
import { generateAnnotationOutput } from '../browserAnnotationOutput.js';
import { BrowserAnnotationMarkers } from '../browserAnnotationMarkers.js';

// -- Context Keys ----------------------------------------------------------

const CONTEXT_BROWSER_ANNOTATION_MODE_ACTIVE = new RawContextKey<boolean>(
	'browserAnnotationModeActive', false,
	localize('browser.annotationModeActive', "Whether browser annotation mode is active")
);

const CONTEXT_BROWSER_HAS_ANNOTATIONS = new RawContextKey<boolean>(
	'browserHasAnnotations', false,
	localize('browser.hasAnnotations', "Whether the browser has any annotations")
);

// -- Annotation Feature Contribution --------------------------------------

/**
 * BrowserEditorContribution that adds multi-element annotation mode to the
 * agentic browser. Users can click multiple elements, add comments, and
 * generate structured markdown output for AI coding agents.
 */
export class BrowserAnnotationFeature extends BrowserEditorContribution {

	private readonly _annotations: IBrowserAnnotation[] = [];
	private _annotationModeActive = false;
	private _currentCts: CancellationTokenSource | undefined;
	private _detailLevel: BrowserAnnotationDetailLevel = 'standard';

	private readonly _annotationModeContext: IContextKey<boolean>;
	private readonly _hasAnnotationsContext: IContextKey<boolean>;
	private readonly _markers = this._register(new MutableDisposable<BrowserAnnotationMarkers>());

	// Floating toolbar DOM
	private readonly _toolbarElement: HTMLElement;
	private readonly _toggleBtn: HTMLButtonElement;
	private readonly _copyBtn: HTMLButtonElement;
	private readonly _sendToChatBtn: HTMLButtonElement;
	private readonly _manageBtn: HTMLButtonElement;
	private readonly _clearBtn: HTMLButtonElement;
	private readonly _countLabel: HTMLElement;

	constructor(
		editor: BrowserEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@INotificationService private readonly notificationService: INotificationService,
		@IBrowserViewCDPService private readonly cdpService: IBrowserViewCDPService,
	) {
		super(editor);
		this._annotationModeContext = CONTEXT_BROWSER_ANNOTATION_MODE_ACTIVE.bindTo(contextKeyService);
		this._hasAnnotationsContext = CONTEXT_BROWSER_HAS_ANNOTATIONS.bindTo(contextKeyService);

		// Build floating toolbar
		this._toolbarElement = $('.browser-annotation-toolbar');

		this._toggleBtn = this._createButton('codicon-checklist', localize('browser.annotateToggle', "Toggle Annotation Mode"));
		this._toolbarElement.appendChild(this._toggleBtn);
		this._register(addDisposableListener(this._toggleBtn, 'click', () => this.toggleAnnotationMode()));

		this._toolbarElement.appendChild(this._createSeparator());
		this._countLabel = $('.browser-annotation-toolbar-count');
		this._countLabel.style.display = 'none';
		this._toolbarElement.appendChild(this._countLabel);

		this._manageBtn = this._createButton('codicon-list-ordered', localize('browser.annotateManage', "Manage Annotations"));
		this._manageBtn.style.display = 'none';
		this._toolbarElement.appendChild(this._manageBtn);
		this._register(addDisposableListener(this._manageBtn, 'click', () => this.manageAnnotations()));

		this._copyBtn = this._createButton('codicon-copy', localize('browser.annotateCopy', "Copy Annotations"));
		this._copyBtn.style.display = 'none';
		this._toolbarElement.appendChild(this._copyBtn);
		this._register(addDisposableListener(this._copyBtn, 'click', () => this.copyAnnotations()));

		this._sendToChatBtn = this._createButton('codicon-comment-discussion', localize('browser.annotateSendToChat', "Send to Chat"));
		this._sendToChatBtn.style.display = 'none';
		this._toolbarElement.appendChild(this._sendToChatBtn);
		this._register(addDisposableListener(this._sendToChatBtn, 'click', () => this.sendAnnotationsToChat()));

		this._clearBtn = this._createButton('codicon-clear-all', localize('browser.annotateClear', "Clear All"));
		this._clearBtn.style.display = 'none';
		this._toolbarElement.appendChild(this._clearBtn);
		this._register(addDisposableListener(this._clearBtn, 'click', () => this.clearAnnotations()));
	}

	override get toolbarElements(): readonly HTMLElement[] {
		return [this._toolbarElement];
	}

	protected override subscribeToModel(model: IBrowserViewModel, store: DisposableStore): void {
		// Create markers instance for this browser view
		const markers = new BrowserAnnotationMarkers(model.id, this.cdpService, this.logService);
		this._markers.value = markers;
		store.add(markers);

		// Show the toolbar when a page is loaded
		this._updateToolbarUI();

		// When the page navigates, exit annotation mode and clear markers
		store.add(model.onDidNavigate(() => {
			markers.resetInjectionState();
			if (this._annotationModeActive) {
				this._stopAnnotationMode();
			}
			this._clearAnnotations();
		}));
	}

	override clear(): void {
		this._stopAnnotationMode();
		this._clearAnnotations();
		// Hide toolbar when model is cleared
		this._toolbarElement.classList.remove('visible');
	}

	// -- Public API (called from actions) ----------------------------------

	/**
	 * Toggle annotation mode on/off.
	 */
	async toggleAnnotationMode(): Promise<void> {
		if (this._annotationModeActive) {
			this._stopAnnotationMode();
		} else {
			await this._startAnnotationMode();
		}
	}

	/**
	 * Copy the current annotations as structured markdown to the clipboard.
	 */
	async copyAnnotations(): Promise<void> {
		if (this._annotations.length === 0) {
			return;
		}

		const url = this.editor.model?.url ?? '';
		const output = generateAnnotationOutput(this._annotations, url, this._detailLevel);
		await this.clipboardService.writeText(output);

		this.notificationService.notify({
			severity: Severity.Info,
			message: localize('browser.annotationsCopied', "Copied {0} annotation(s) to clipboard", this._annotations.length),
		});
	}

	/**
	 * Send annotations to chat as a structured attachment.
	 */
	async sendAnnotationsToChat(): Promise<void> {
		if (this._annotations.length === 0) {
			return;
		}

		const url = this.editor.model?.url ?? '';
		const output = generateAnnotationOutput(this._annotations, url, this._detailLevel);

		const toAttach: IChatRequestVariableEntry[] = [{
			id: 'browser-annotations-' + Date.now(),
			name: localize('browser.annotationsAttachmentName', "Page Annotations ({0})", this._annotations.length),
			fullName: localize('browser.annotationsAttachmentFullName', "Browser Page Annotations"),
			value: output,
			modelDescription: 'Structured browser page annotations with element context and user feedback.',
			kind: 'element',
			icon: ThemeIcon.fromId(Codicon.checklist.id),
		}];

		const widget = await this.chatWidgetService.revealWidget() ?? this.chatWidgetService.lastFocusedWidget;
		widget?.attachmentModel?.addContext(...toAttach);
	}

	/**
	 * Clear all annotations.
	 */
	clearAnnotations(): void {
		this._clearAnnotations();
	}

	/**
	 * Delete a single annotation by ID.
	 */
	deleteAnnotation(annotationId: string): void {
		const idx = this._annotations.findIndex(a => a.id === annotationId);
		if (idx !== -1) {
			this._annotations.splice(idx, 1);
			// Re-index remaining annotations
			for (let i = 0; i < this._annotations.length; i++) {
				(this._annotations[i] as { index: number }).index = i + 1;
			}
			this._updateHasAnnotationsContext();
			this._syncMarkers();
		}
	}

	/**
	 * Show a quick pick to manage annotations (edit comment, delete, or clear all).
	 */
	async manageAnnotations(): Promise<void> {
		if (this._annotations.length === 0) {
			return;
		}

		interface IAnnotationQuickPickItem {
			label: string;
			description: string;
			annotationId?: string;
			action: 'edit' | 'delete' | 'clearAll';
		}

		const items: (IAnnotationQuickPickItem | { type: 'separator'; label?: string })[] = this._annotations.map(a => ({
			label: `$(list-ordered) #${a.index} ${a.displayName}`,
			description: a.comment.length > 60 ? a.comment.slice(0, 60) + '...' : a.comment,
			annotationId: a.id,
			action: 'edit' as const,
		}));

		items.push(
			{ type: 'separator' },
			{ label: `$(trash) ${localize('browser.clearAllAnnotations', "Clear All Annotations")}`, description: '', action: 'clearAll' },
		);

		const picked = await this.quickInputService.pick(items, {
			title: localize('browser.manageAnnotationsTitle', "Manage Annotations"),
			placeHolder: localize('browser.manageAnnotationsPlaceholder', "Select an annotation to edit or delete"),
		}) as IAnnotationQuickPickItem | undefined;

		if (!picked) {
			return;
		}

		if (picked.action === 'clearAll') {
			this._clearAnnotations();
			return;
		}

		if (picked.annotationId) {
			await this._editOrDeleteAnnotation(picked.annotationId);
		}
	}

	private async _editOrDeleteAnnotation(annotationId: string): Promise<void> {
		const annotation = this._annotations.find(a => a.id === annotationId);
		if (!annotation) {
			return;
		}

		const editLabel = localize('browser.editAnnotationComment', "Edit Comment");
		const deleteLabel = localize('browser.deleteAnnotation', "Delete Annotation");

		const action = await this.quickInputService.pick([
			{ label: `$(edit) ${editLabel}`, action: 'edit' },
			{ label: `$(trash) ${deleteLabel}`, action: 'delete' },
		] as Array<{ label: string; action: string }>, {
			title: localize('browser.annotationAction', "#{0} {1}", annotation.index, annotation.displayName),
		}) as { label: string; action: string } | undefined;

		if (!action) {
			return;
		}

		if (action.action === 'delete') {
			this.deleteAnnotation(annotationId);
			return;
		}

		if (action.action === 'edit') {
			const newComment = await this.quickInputService.input({
				title: localize('browser.editAnnotation', "Edit Annotation #{0}", annotation.index),
				value: annotation.comment,
				validateInput: async (value) => {
					if (!value.trim()) {
						return localize('browser.annotationCommentRequired', "A comment is required");
					}
					return undefined;
				}
			});

			if (newComment !== undefined && newComment.trim()) {
				const idx = this._annotations.findIndex(a => a.id === annotationId);
				if (idx !== -1) {
					(this._annotations[idx] as { comment: string }).comment = newComment;
					this._syncMarkers();
				}
			}
		}
	}

	/**
	 * Get the current annotations.
	 */
	getAnnotations(): readonly IBrowserAnnotation[] {
		return this._annotations;
	}

	// -- Private -----------------------------------------------------------

	private async _startAnnotationMode(): Promise<void> {
		const model = this.editor.model;
		if (!model) {
			return;
		}

		this._annotationModeActive = true;
		this._annotationModeContext.set(true);
		this._updateToolbarUI();
		this.editor.ensureBrowserFocus();

		this.logService.debug('BrowserAnnotationFeature: Annotation mode started');

		// Enter the annotation loop — stays active until mode is toggled off
		this._runAnnotationLoop();
	}

	private _stopAnnotationMode(): void {
		this._annotationModeActive = false;
		this._annotationModeContext.set(false);
		this._updateToolbarUI();

		if (this._currentCts) {
			this._currentCts.dispose(true);
			this._currentCts = undefined;
		}

		this.logService.debug('BrowserAnnotationFeature: Annotation mode stopped');
	}

	/**
	 * Continuously select elements and prompt for comments until annotation mode is deactivated.
	 * Each iteration: enter CDP inspect mode → wait for click → extract data → prompt comment → store.
	 */
	private async _runAnnotationLoop(): Promise<void> {
		while (this._annotationModeActive) {
			const model = this.editor.model;
			if (!model) {
				this._stopAnnotationMode();
				return;
			}

			const cts = new CancellationTokenSource();
			this._currentCts = cts;

			try {
				// Wait for user to click an element (CDP Overlay.setInspectMode)
				const elementData = await model.getElementData(cts.token);

				if (cts.token.isCancellationRequested || !this._annotationModeActive) {
					break;
				}

				if (!elementData) {
					continue;
				}

				// Prompt for comment
				const comment = await this.quickInputService.input({
					title: localize('browser.annotationComment', "Annotation Comment"),
					placeHolder: localize('browser.annotationCommentPlaceholder', "What feedback do you have for this element?"),
					validateInput: async (value) => {
						if (!value.trim()) {
							return localize('browser.annotationCommentRequired', "A comment is required");
						}
						return undefined;
					}
				});

				if (!comment || !this._annotationModeActive) {
					// User cancelled the input — stay in annotation mode, just skip this one
					if (!this._annotationModeActive) {
						break;
					}
					continue;
				}

				// Create and store the annotation
				const annotation = createBrowserAnnotation(
					elementData,
					comment,
					this._annotations.length + 1,
					model.url,
				);
				this._annotations.push(annotation);
				this._updateHasAnnotationsContext();
				this._syncMarkers();

				this.logService.debug(`BrowserAnnotationFeature: Added annotation #${annotation.index} for ${annotation.displayName}`);

				// Re-focus the browser for the next selection
				this.editor.ensureBrowserFocus();

			} catch (error) {
				if (!cts.token.isCancellationRequested) {
					this.logService.error('BrowserAnnotationFeature: Error during annotation', error);
				}
				break;
			} finally {
				cts.dispose();
				if (this._currentCts === cts) {
					this._currentCts = undefined;
				}
			}
		}
	}

	private _syncMarkers(): void {
		this._markers.value?.updateMarkers(this._annotations);
	}

	private _clearAnnotations(): void {
		this._annotations.length = 0;
		this._updateHasAnnotationsContext();
		this._markers.value?.clearMarkers();
	}

	private _updateHasAnnotationsContext(): void {
		const hasAnnotations = this._annotations.length > 0;
		this._hasAnnotationsContext.set(hasAnnotations);
		this._updateToolbarUI();
	}

	private _updateToolbarUI(): void {
		const hasModel = !!this.editor.model?.url;
		const hasAnnotations = this._annotations.length > 0;

		// Always show the toolbar when a page is loaded
		this._toolbarElement.classList.toggle('visible', hasModel);
		this._toggleBtn.classList.toggle('active', this._annotationModeActive);

		// Show/hide annotation-dependent buttons
		const annotationDisplay = hasAnnotations ? '' : 'none';
		this._countLabel.style.display = annotationDisplay;
		this._countLabel.textContent = `${this._annotations.length}`;
		this._manageBtn.style.display = annotationDisplay;
		this._copyBtn.style.display = annotationDisplay;
		this._sendToChatBtn.style.display = annotationDisplay;
		this._clearBtn.style.display = annotationDisplay;
	}

	private _createButton(iconClass: string, title: string): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.className = 'browser-annotation-toolbar-button';
		btn.title = title;
		const icon = document.createElement('span');
		icon.className = `codicon ${iconClass}`;
		btn.appendChild(icon);
		return btn;
	}

	private _createSeparator(): HTMLElement {
		const sep = document.createElement('div');
		sep.className = 'browser-annotation-toolbar-separator';
		return sep;
	}
}

// Register the contribution
BrowserEditor.registerContribution(BrowserAnnotationFeature);

// -- Actions ---------------------------------------------------------------

class ToggleAnnotationModeAction extends Action2 {
	static readonly ID = 'workbench.action.browser.toggleAnnotationMode';

	constructor() {
		const enabled = ContextKeyExpr.and(
			ChatContextKeys.enabled,
			ContextKeyExpr.equals('config.chat.sendElementsToChat.enabled', true),
		);
		super({
			id: ToggleAnnotationModeAction.ID,
			title: localize2('browser.toggleAnnotationMode', 'Toggle Annotation Mode'),
			category: BrowserActionCategory,
			icon: Codicon.checklist,
			f1: true,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL, CONTEXT_BROWSER_HAS_ERROR.negate(), enabled),
			toggled: CONTEXT_BROWSER_ANNOTATION_MODE_ACTIVE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const browserEditor = accessor.get(IEditorService).activeEditorPane;
		if (browserEditor instanceof BrowserEditor) {
			await browserEditor.getContribution(BrowserAnnotationFeature)?.toggleAnnotationMode();
		}
	}
}

class CopyAnnotationsAction extends Action2 {
	static readonly ID = 'workbench.action.browser.copyAnnotations';

	constructor() {
		super({
			id: CopyAnnotationsAction.ID,
			title: localize2('browser.copyAnnotations', 'Copy Annotations'),
			category: BrowserActionCategory,
			icon: Codicon.copy,
			f1: true,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_ANNOTATIONS),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const browserEditor = accessor.get(IEditorService).activeEditorPane;
		if (browserEditor instanceof BrowserEditor) {
			await browserEditor.getContribution(BrowserAnnotationFeature)?.copyAnnotations();
		}
	}
}

class SendAnnotationsToChatAction extends Action2 {
	static readonly ID = 'workbench.action.browser.sendAnnotationsToChat';

	constructor() {
		super({
			id: SendAnnotationsToChatAction.ID,
			title: localize2('browser.sendAnnotationsToChat', 'Send Annotations to Chat'),
			category: BrowserActionCategory,
			icon: Codicon.commentDiscussion,
			f1: true,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_ANNOTATIONS, ChatContextKeys.enabled),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const browserEditor = accessor.get(IEditorService).activeEditorPane;
		if (browserEditor instanceof BrowserEditor) {
			await browserEditor.getContribution(BrowserAnnotationFeature)?.sendAnnotationsToChat();
		}
	}
}

class ClearAnnotationsAction extends Action2 {
	static readonly ID = 'workbench.action.browser.clearAnnotations';

	constructor() {
		super({
			id: ClearAnnotationsAction.ID,
			title: localize2('browser.clearAnnotations', 'Clear Annotations'),
			category: BrowserActionCategory,
			icon: Codicon.clearAll,
			f1: true,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_ANNOTATIONS),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const browserEditor = accessor.get(IEditorService).activeEditorPane;
		if (browserEditor instanceof BrowserEditor) {
			browserEditor.getContribution(BrowserAnnotationFeature)?.clearAnnotations();
		}
	}
}

class ExitAnnotationModeAction extends Action2 {
	static readonly ID = 'workbench.action.browser.exitAnnotationMode';

	constructor() {
		super({
			id: ExitAnnotationModeAction.ID,
			title: localize2('browser.exitAnnotationMode', 'Exit Annotation Mode'),
			category: BrowserActionCategory,
			f1: false,
			precondition: CONTEXT_BROWSER_ANNOTATION_MODE_ACTIVE,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.Escape,
				when: CONTEXT_BROWSER_ANNOTATION_MODE_ACTIVE,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const browserEditor = accessor.get(IEditorService).activeEditorPane;
		if (browserEditor instanceof BrowserEditor) {
			await browserEditor.getContribution(BrowserAnnotationFeature)?.toggleAnnotationMode();
		}
	}
}

registerAction2(ToggleAnnotationModeAction);
registerAction2(CopyAnnotationsAction);
registerAction2(SendAnnotationsToChatAction);
registerAction2(ClearAnnotationsAction);
registerAction2(ExitAnnotationModeAction);

class ManageAnnotationsAction extends Action2 {
	static readonly ID = 'workbench.action.browser.manageAnnotations';

	constructor() {
		super({
			id: ManageAnnotationsAction.ID,
			title: localize2('browser.manageAnnotationsAction', 'Manage Annotations'),
			category: BrowserActionCategory,
			icon: Codicon.listOrdered,
			f1: true,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_ANNOTATIONS),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const browserEditor = accessor.get(IEditorService).activeEditorPane;
		if (browserEditor instanceof BrowserEditor) {
			await browserEditor.getContribution(BrowserAnnotationFeature)?.manageAnnotations();
		}
	}
}

registerAction2(ManageAnnotationsAction);
