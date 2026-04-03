/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Event } from '../../../../../base/common/event.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { IMarkdownRendererService, MarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ChatProgressContentPart } from '../../../../contrib/chat/browser/widget/chatContentParts/chatProgressContentPart.js';
import { ChatContentMarkdownRenderer } from '../../../../contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import { IChatContentPartRenderContext, InlineTextModelCollection } from '../../../../contrib/chat/browser/widget/chatContentParts/chatContentParts.js';
import { IChatMarkdownAnchorService } from '../../../../contrib/chat/browser/widget/chatContentParts/chatMarkdownAnchorService.js';
import { IChatProgressMessage, ChatErrorLevel } from '../../../../contrib/chat/common/chatService/chatService.js';
import { IChatResponseViewModel } from '../../../../contrib/chat/common/model/chatViewModel.js';
import { SimpleChatConfirmationWidget } from '../../../../contrib/chat/browser/widget/chatContentParts/chatConfirmationWidget.js';
import { ChatErrorWidget } from '../../../../contrib/chat/browser/widget/chatContentParts/chatErrorContentPart.js';
import { ComponentFixtureContext, createEditorServices, defineComponentFixture, defineThemedFixtureGroup, registerWorkbenchServices } from '../fixtureUtils.js';

import '../../../../contrib/chat/browser/widget/media/chat.css';
import '../../../../contrib/chat/browser/widget/chatContentParts/media/chatConfirmationWidget.css';

const $ = dom.$;

// ============================================================================
// Shared helpers
// ============================================================================

function createMockContext(opts?: { isComplete?: boolean; hasFollowingContent?: boolean }): IChatContentPartRenderContext {
	const element = new class extends mock<IChatResponseViewModel>() {
		override readonly isComplete = opts?.isComplete ?? false;
	}();
	return {
		element,
		inlineTextModels: upcastPartial<InlineTextModelCollection>({}),
		elementIndex: 0,
		container: document.createElement('div'),
		content: opts?.hasFollowingContent ? [{ kind: 'progressMessage', content: new MarkdownString('test') }] : [],
		contentIndex: 0,
		editorPool: undefined!,
		codeBlockStartIndex: 0,
		treeStartIndex: 0,
		diffEditorPool: undefined!,
		currentWidth: observableValue('currentWidth', 500),
		onDidChangeVisibility: Event.None,
	};
}

function setupContainer(container: HTMLElement): HTMLElement {
	container.style.width = '600px';
	container.style.padding = '16px';
	container.style.display = 'flex';
	container.style.flexDirection = 'column';
	container.style.gap = '16px';
	container.classList.add('interactive-session');
	container.classList.add('monaco-workbench');
	return container;
}

function addSectionLabel(parent: HTMLElement, label: string): void {
	const labelEl = $('div');
	labelEl.style.fontSize = '11px';
	labelEl.style.fontWeight = '600';
	labelEl.style.textTransform = 'uppercase';
	labelEl.style.letterSpacing = '0.5px';
	labelEl.style.color = 'var(--vscode-descriptionForeground)';
	labelEl.style.marginBottom = '-8px';
	labelEl.textContent = label;
	parent.appendChild(labelEl);
}

function addItemContainer(parent: HTMLElement): HTMLElement {
	const itemContainer = $('div.interactive-item-container');
	parent.appendChild(itemContainer);
	return itemContainer;
}

// ============================================================================
// Markdown section
// ============================================================================

function renderMarkdownShowcase(ctx: ComponentFixtureContext): void {
	const { container, disposableStore } = ctx;
	setupContainer(container);

	const mockAnchorService = new class extends mock<IChatMarkdownAnchorService>() {
		override register() { return { dispose() { } }; }
	}();

	const instantiationService = createEditorServices(disposableStore, {
		colorTheme: ctx.theme,
		additionalServices: (reg) => {
			reg.define(IMarkdownRendererService, MarkdownRendererService);
			reg.defineInstance(IChatMarkdownAnchorService, mockAnchorService);
		},
	});
	const markdownRenderer = instantiationService.createInstance(ChatContentMarkdownRenderer);

	// --- User message ---
	addSectionLabel(container, 'User Request');
	const userBubble = $('div');
	userBubble.style.padding = '8px 12px';
	userBubble.style.borderRadius = '8px';
	userBubble.style.backgroundColor = 'var(--vscode-input-background)';
	userBubble.style.color = 'var(--vscode-input-foreground)';
	userBubble.style.fontSize = 'var(--vscode-font-size)';
	userBubble.textContent = 'Can you help me refactor the authentication middleware to use async/await?';
	container.appendChild(userBubble);

	// --- Markdown response ---
	addSectionLabel(container, 'Markdown Response');
	const md = new MarkdownString();
	md.appendMarkdown('Sure! Here\'s how we can refactor the authentication middleware:\n\n');
	md.appendMarkdown('### Key Changes\n\n');
	md.appendMarkdown('1. Replace `.then()` chains with `async/await`\n');
	md.appendMarkdown('2. Add proper **error handling** with `try/catch`\n');
	md.appendMarkdown('3. Use `const` instead of `let` where possible\n\n');
	md.appendMarkdown('> **Note:** This will require Node.js 14+ for full async/await support.\n\n');
	md.appendMarkdown('Here\'s the refactored code:\n\n');
	md.appendCodeblock('typescript', [
		'export async function authenticate(req: Request, res: Response, next: NextFunction) {',
		'  try {',
		'    const token = req.headers.authorization?.split(\' \')[1];',
		'    if (!token) {',
		'      throw new UnauthorizedError(\'No token provided\');',
		'    }',
		'',
		'    const decoded = await verifyToken(token);',
		'    req.user = decoded;',
		'    next();',
		'  } catch (error) {',
		'    res.status(401).json({ message: \'Authentication failed\' });',
		'  }',
		'}',
	].join('\n'));

	const rendered = disposableStore.add(markdownRenderer.render(md));
	rendered.element.classList.add('rendered-markdown');
	const itemContainer = addItemContainer(container);
	itemContainer.appendChild(rendered.element);
}

// ============================================================================
// Progress messages section
// ============================================================================

function renderProgressShowcase(ctx: ComponentFixtureContext): void {
	const { container, disposableStore } = ctx;
	setupContainer(container);

	const mockAnchorService = new class extends mock<IChatMarkdownAnchorService>() {
		override register() { return { dispose() { } }; }
	}();

	const instantiationService = createEditorServices(disposableStore, {
		colorTheme: ctx.theme,
		additionalServices: (reg) => {
			reg.define(IMarkdownRendererService, MarkdownRendererService);
			reg.defineInstance(IChatMarkdownAnchorService, mockAnchorService);
		},
	});
	const markdownRenderer = instantiationService.createInstance(ChatContentMarkdownRenderer);

	// Completed progress
	addSectionLabel(container, 'Completed Progress Step');
	const completedMsg: IChatProgressMessage = {
		kind: 'progressMessage',
		content: new MarkdownString('Analyzed 12 files in `src/auth/`'),
	};
	const completedPart = disposableStore.add(instantiationService.createInstance(
		ChatProgressContentPart, completedMsg, markdownRenderer,
		createMockContext({ isComplete: true, hasFollowingContent: true }),
		false, true, undefined, undefined, undefined,
	));
	const completedContainer = addItemContainer(container);
	completedContainer.appendChild(completedPart.domNode);

	// Active progress with spinner
	addSectionLabel(container, 'Active Progress (Spinner)');
	const activeMsg: IChatProgressMessage = {
		kind: 'progressMessage',
		content: new MarkdownString('Refactoring authentication middleware...'),
	};
	const activePart = disposableStore.add(instantiationService.createInstance(
		ChatProgressContentPart, activeMsg, markdownRenderer,
		createMockContext({ isComplete: false }),
		true, true, undefined, undefined, undefined,
	));
	const activeContainer = addItemContainer(container);
	activeContainer.appendChild(activePart.domNode);

	// Progress with shimmer
	addSectionLabel(container, 'Progress (Shimmer)');
	const shimmerMsg: IChatProgressMessage = {
		kind: 'progressMessage',
		content: new MarkdownString('Searching workspace for related patterns...'),
	};
	const shimmerPart = disposableStore.add(instantiationService.createInstance(
		ChatProgressContentPart, shimmerMsg, markdownRenderer,
		createMockContext({ isComplete: false }),
		true, true, undefined, undefined, true,
	));
	const shimmerContainer = addItemContainer(container);
	shimmerContainer.appendChild(shimmerPart.domNode);

	// Progress with custom icon
	addSectionLabel(container, 'Progress (Custom Icon)');
	const iconMsg: IChatProgressMessage = {
		kind: 'progressMessage',
		content: new MarkdownString('Running test suite...'),
	};
	const iconPart = disposableStore.add(instantiationService.createInstance(
		ChatProgressContentPart, iconMsg, markdownRenderer,
		createMockContext({ isComplete: true, hasFollowingContent: true }),
		false, true, Codicon.beaker, undefined, undefined,
	));
	const iconContainer = addItemContainer(container);
	iconContainer.appendChild(iconPart.domNode);
}

// ============================================================================
// Confirmation widget section
// ============================================================================

function renderConfirmationShowcase(ctx: ComponentFixtureContext): void {
	const { container, disposableStore } = ctx;
	setupContainer(container);

	const mockAnchorService = new class extends mock<IChatMarkdownAnchorService>() {
		override register() { return { dispose() { } }; }
	}();

	const instantiationService = createEditorServices(disposableStore, {
		colorTheme: ctx.theme,
		additionalServices: (reg) => {
			registerWorkbenchServices(reg);
			reg.define(IMarkdownRendererService, MarkdownRendererService);
			reg.defineInstance(IChatMarkdownAnchorService, mockAnchorService);
		},
	});

	// Standard confirmation
	addSectionLabel(container, 'Confirmation Dialog');
	const confirmation = disposableStore.add(instantiationService.createInstance(
		SimpleChatConfirmationWidget,
		createMockContext({ isComplete: false }),
		{
			title: 'Delete 3 Unused Files',
			message: 'The following files appear to be unused and can be safely removed:\n- `src/old-auth.ts`\n- `src/deprecated-helper.ts`\n- `test/legacy.test.ts`',
			buttons: [
				{ label: 'Delete Files', data: {} },
				{ label: 'Skip', data: {}, isSecondary: true },
			],
		},
	));
	confirmation.setShowButtons(true);
	container.appendChild(confirmation.domNode);

	// Confirmation with dangerous action
	addSectionLabel(container, 'Dangerous Action Confirmation');
	const dangerConfirmation = disposableStore.add(instantiationService.createInstance(
		SimpleChatConfirmationWidget,
		createMockContext({ isComplete: false }),
		{
			title: 'Run Database Migration',
			message: 'This will modify the production database schema. This action cannot be easily reversed.',
			buttons: [
				{ label: 'Run Migration', data: {} },
				{ label: 'Cancel', data: {}, isSecondary: true },
			],
		},
	));
	dangerConfirmation.setShowButtons(true);
	container.appendChild(dangerConfirmation.domNode);
}

// ============================================================================
// Error & Warning messages section
// ============================================================================

function renderErrorsShowcase(ctx: ComponentFixtureContext): void {
	const { container, disposableStore } = ctx;
	setupContainer(container);

	const instantiationService = createEditorServices(disposableStore, {
		colorTheme: ctx.theme,
		additionalServices: (reg) => {
			reg.define(IMarkdownRendererService, MarkdownRendererService);
		},
	});
	const renderer = instantiationService.get(IMarkdownRendererService);

	// Error
	addSectionLabel(container, 'Error');
	const errorWidget = disposableStore.add(new ChatErrorWidget(
		ChatErrorLevel.Error,
		new MarkdownString('Failed to apply edits: file `src/auth.ts` has been modified externally.'),
		renderer,
	));
	container.appendChild(errorWidget.domNode);

	// Warning
	addSectionLabel(container, 'Warning');
	const warningWidget = disposableStore.add(new ChatErrorWidget(
		ChatErrorLevel.Warning,
		new MarkdownString('The generated code uses a deprecated API. Consider updating to the v2 endpoint.'),
		renderer,
	));
	container.appendChild(warningWidget.domNode);

	// Info
	addSectionLabel(container, 'Info');
	const infoWidget = disposableStore.add(new ChatErrorWidget(
		ChatErrorLevel.Info,
		new MarkdownString('Using model **GPT-5.3-Codex** for this request.'),
		renderer,
	));
	container.appendChild(infoWidget.domNode);
}

// ============================================================================
// Command buttons section
// ============================================================================

function renderCommandButtonsShowcase(ctx: ComponentFixtureContext): void {
	const { container } = ctx;
	setupContainer(container);

	addSectionLabel(container, 'Command Buttons');
	const buttonContainer = $('div.chat-command-button');
	buttonContainer.style.display = 'flex';
	buttonContainer.style.gap = '8px';
	buttonContainer.style.flexWrap = 'wrap';

	const primaryBtn = new Button(buttonContainer, { ...defaultButtonStyles, supportIcons: true, title: 'Apply all changes' });
	primaryBtn.label = '$(check) Apply Changes';
	primaryBtn.enabled = true;

	const secondaryBtn = new Button(buttonContainer, { ...defaultButtonStyles, supportIcons: true, title: 'Show the diff for all changes', secondary: true });
	secondaryBtn.label = '$(diff) Show Diff';
	secondaryBtn.enabled = true;

	const disabledBtn = new Button(buttonContainer, { ...defaultButtonStyles, supportIcons: true, title: 'Button not available in restored chat', secondary: true });
	disabledBtn.label = '$(debug-restart) Retry';
	disabledBtn.enabled = false;

	container.appendChild(buttonContainer);
}

// ============================================================================
// Combined "full conversation" showcase
// ============================================================================

function renderFullConversation(ctx: ComponentFixtureContext): void {
	const { container, disposableStore } = ctx;
	setupContainer(container);

	const mockAnchorService = new class extends mock<IChatMarkdownAnchorService>() {
		override register() { return { dispose() { } }; }
	}();

	const instantiationService = createEditorServices(disposableStore, {
		colorTheme: ctx.theme,
		additionalServices: (reg) => {
			registerWorkbenchServices(reg);
			reg.define(IMarkdownRendererService, MarkdownRendererService);
			reg.defineInstance(IChatMarkdownAnchorService, mockAnchorService);
		},
	});
	const markdownRenderer = instantiationService.createInstance(ChatContentMarkdownRenderer);
	const mdRenderer = instantiationService.get(IMarkdownRendererService);

	// --- Turn 1: User message ---
	const userMsg = $('div');
	userMsg.style.padding = '8px 12px';
	userMsg.style.borderRadius = '8px';
	userMsg.style.backgroundColor = 'var(--vscode-input-background)';
	userMsg.style.color = 'var(--vscode-input-foreground)';
	userMsg.textContent = 'Add input validation to the user registration endpoint';
	container.appendChild(userMsg);

	// --- Turn 1: Progress steps ---
	const progress1Msg: IChatProgressMessage = { kind: 'progressMessage', content: new MarkdownString('$(file) Reading `src/routes/register.ts`') };
	const progress1 = disposableStore.add(instantiationService.createInstance(
		ChatProgressContentPart,
		progress1Msg,
		markdownRenderer,
		createMockContext({ isComplete: true, hasFollowingContent: true }),
		false, true, undefined, undefined, undefined,
	));
	const p1Container = addItemContainer(container);
	p1Container.appendChild(progress1.domNode);

	const progress2Msg: IChatProgressMessage = { kind: 'progressMessage', content: new MarkdownString('$(search) Analyzing validation requirements') };
	const progress2 = disposableStore.add(instantiationService.createInstance(
		ChatProgressContentPart,
		progress2Msg,
		markdownRenderer,
		createMockContext({ isComplete: true, hasFollowingContent: true }),
		false, true, undefined, undefined, undefined,
	));
	const p2Container = addItemContainer(container);
	p2Container.appendChild(progress2.domNode);

	// --- Turn 1: Markdown response ---
	const responseMd = new MarkdownString();
	responseMd.appendMarkdown('I\'ll add input validation to the registration endpoint using `zod`:\n\n');
	responseMd.appendCodeblock('typescript', [
		'import { z } from \'zod\';',
		'',
		'const registerSchema = z.object({',
		'  email: z.string().email(\'Invalid email address\'),',
		'  password: z.string().min(8, \'Password must be at least 8 characters\'),',
		'  name: z.string().min(1, \'Name is required\').max(100),',
		'});',
	].join('\n'));
	responseMd.appendMarkdown('\nThis adds validation for:\n');
	responseMd.appendMarkdown('- **Email** — proper email format\n');
	responseMd.appendMarkdown('- **Password** — minimum 8 characters\n');
	responseMd.appendMarkdown('- **Name** — required, max 100 chars\n');

	const responseRendered = disposableStore.add(markdownRenderer.render(responseMd));
	responseRendered.element.classList.add('rendered-markdown');
	const responseContainer = addItemContainer(container);
	responseContainer.appendChild(responseRendered.element);

	// --- Confirmation ---
	const confirmation = disposableStore.add(instantiationService.createInstance(
		SimpleChatConfirmationWidget,
		createMockContext({ isComplete: false }),
		{
			title: 'Install `zod` Package',
			message: 'The validation uses `zod` which is not yet in your dependencies. Install it?',
			buttons: [
				{ label: 'Install', data: {} },
				{ label: 'Skip', data: {}, isSecondary: true },
			],
		},
	));
	confirmation.setShowButtons(true);
	container.appendChild(confirmation.domNode);

	// --- Warning ---
	const warning = disposableStore.add(new ChatErrorWidget(
		ChatErrorLevel.Warning,
		new MarkdownString('The existing tests in `register.test.ts` may need updating for the new validation.'),
		mdRenderer,
	));
	container.appendChild(warning.domNode);

	// --- Follow-up buttons ---
	const buttonContainer = $('div.chat-command-button');
	buttonContainer.style.display = 'flex';
	buttonContainer.style.gap = '8px';
	buttonContainer.style.flexWrap = 'wrap';

	const applyBtn = new Button(buttonContainer, { ...defaultButtonStyles, supportIcons: true, title: 'Apply the changes' });
	applyBtn.label = '$(check) Apply Changes';
	applyBtn.enabled = true;

	const testBtn = new Button(buttonContainer, { ...defaultButtonStyles, supportIcons: true, title: 'Update related tests', secondary: true });
	testBtn.label = '$(beaker) Update Tests';
	testBtn.enabled = true;

	container.appendChild(buttonContainer);
}

// ============================================================================
// Fixtures
// ============================================================================

export default defineThemedFixtureGroup({ path: 'chat/showcase/' }, {

	// Individual content type showcases
	'Markdown Response': defineComponentFixture({
		render: renderMarkdownShowcase,
	}),

	'Progress Messages': defineComponentFixture({
		render: renderProgressShowcase,
	}),

	'Confirmation Dialogs': defineComponentFixture({
		render: renderConfirmationShowcase,
	}),

	'Errors and Warnings': defineComponentFixture({
		render: renderErrorsShowcase,
	}),

	'Command Buttons': defineComponentFixture({
		render: renderCommandButtonsShowcase,
	}),

	// Full conversation combining multiple content types
	'Full Conversation': defineComponentFixture({
		render: renderFullConversation,
	}),
});
