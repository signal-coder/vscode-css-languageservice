/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
import * as scssScanner from './scssScanner';
import { TokenType } from './cssScanner';
import * as cssParser from './cssParser';
import * as nodes from './cssNodes';

import { SCSSParseError } from './scssErrors';
import { ParseError } from './cssErrors';

/// <summary>
/// A parser for scss
/// http://sass-lang.com/documentation/file.SASS_REFERENCE.html
/// </summary>
export class SCSSParser extends cssParser.Parser {

	public constructor() {
		super(new scssScanner.SCSSScanner());
	}

	public _parseStylesheetStatement(isNested: boolean = false): nodes.Node | null {
		if (this.peek(TokenType.AtKeyword)) {
			return this._parseWarnAndDebug() // @warn, @debug and @error statements
				|| this._parseControlStatement() // @if, @while, @for, @each
				|| this._parseMixinDeclaration() // @mixin
				|| this._parseMixinContent() // @content
				|| this._parseMixinReference() // @include
				|| this._parseFunctionDeclaration() // @function
				|| this._parseForward() // @forward
				|| this._parseUse() // @use
				|| this._parseRuleset(isNested) // @at-rule
				|| super._parseStylesheetAtStatement(isNested);
		}
		return this._parseRuleset(true) || this._parseVariableDeclaration();
	}

	public _parseImport(): nodes.Node | null {

		if (!this.peekKeyword('@import')) {
			return null;
		}
		const node = <nodes.Import>this.create(nodes.Import);
		this.consumeToken();


		if (!node.addChild(this._parseURILiteral()) && !node.addChild(this._parseStringLiteral())) {
			return this.finish(node, ParseError.URIOrStringExpected);
		}
		while (this.accept(TokenType.Comma)) {
			if (!node.addChild(this._parseURILiteral()) && !node.addChild(this._parseStringLiteral())) {
				return this.finish(node, ParseError.URIOrStringExpected);
			}
		}

		return this._completeParseImport(node);
	}

	// scss variables: $font-size: 12px;
	public _parseVariableDeclaration(panic: TokenType[] = []): nodes.VariableDeclaration | null {
		if (!this.peek(scssScanner.VariableName)) {
			return null;
		}

		const node = <nodes.VariableDeclaration>this.create(nodes.VariableDeclaration);

		if (!node.setVariable(this._parseVariable())) {
			return null;
		}

		if (!this.accept(TokenType.Colon)) {
			return this.finish(node, ParseError.ColonExpected);
		}
		if (this.prevToken) {
			node.colonPosition = this.prevToken.offset;
		}

		if (!node.setValue(this._parseExpr())) {
			return this.finish(node, ParseError.VariableValueExpected, [], panic);
		}

		while (this.peek(TokenType.Exclamation)) {
			if (node.addChild(this._tryParsePrio())) {
				// !important
			} else {
				this.consumeToken();
				if (!this.peekRegExp(TokenType.Ident, /^(default|global)$/)) {
					return this.finish(node, ParseError.UnknownKeyword);
				}
				this.consumeToken();
			}
		}

		if (this.peek(TokenType.SemiColon)) {
			node.semicolonPosition = this.token.offset; // not part of the declaration, but useful information for code assist
		}

		return this.finish(node);
	}

	public _parseMediaCondition(): nodes.Node | null {
		return this._parseInterpolation() || super._parseMediaCondition();
	}

	public _parseMediaFeatureRangeOperator() : boolean {
		return this.accept(scssScanner.SmallerEqualsOperator) || this.accept(scssScanner.GreaterEqualsOperator) || super._parseMediaFeatureRangeOperator();
	}

	public _parseMediaFeatureName(): nodes.Node | null {
		return this._parseModuleMember()
			|| this._parseFunction() // function before ident
			|| this._parseIdent()
			|| this._parseVariable();
	}

	public _parseKeyframeSelector(): nodes.Node | null {
		return this._tryParseKeyframeSelector()
			|| this._parseControlStatement(this._parseKeyframeSelector.bind(this))
			|| this._parseWarnAndDebug() // @warn, @debug and @error statements
			|| this._parseMixinReference() // @include
			|| this._parseFunctionDeclaration() // @function
			|| this._parseVariableDeclaration()
			|| this._parseMixinContent();
	}

	public _parseVariable(): nodes.Variable | null {
		if (!this.peek(scssScanner.VariableName)) {
			return null;
		}
		const node = <nodes.Variable>this.create(nodes.Variable);
		this.consumeToken();
		return <nodes.Variable>node;
	}

	public _parseModuleMember(): nodes.Module | null {

		const pos = this.mark();
		const node = <nodes.Module>this.create(nodes.Module);

		if (!node.setIdentifier(this._parseIdent([nodes.ReferenceType.Module]))) {
			return null;
		}

		if (this.hasWhitespace()
			|| !this.acceptDelim('.')
			|| this.hasWhitespace()) {
			this.restoreAtMark(pos);
			return null;
		}

		if (!node.addChild(this._parseVariable() || this._parseFunction())) {
			return this.finish(node, ParseError.IdentifierOrVariableExpected);
		}

		return node;
	}

	public _parseIdent(referenceTypes?: nodes.ReferenceType[]): nodes.Identifier | null {
		if (!this.peek(TokenType.Ident) && !this.peek(scssScanner.InterpolationFunction) && !this.peekDelim('-')) {
			return null;
		}

		const node = <nodes.Identifier>this.create(nodes.Identifier);
		node.referenceTypes = referenceTypes;
		node.isCustomProperty = this.peekRegExp(TokenType.Ident, /^--/);
		let hasContent = false;

		const indentInterpolation = () => {
			const pos = this.mark();
			if (this.acceptDelim('-')) {
				if (!this.hasWhitespace()) {
					this.acceptDelim('-');
				}
				if (this.hasWhitespace()) {
					this.restoreAtMark(pos);
					return null;
				}
			}
			return this._parseInterpolation();
		};

		while (this.accept(TokenType.Ident) || node.addChild(indentInterpolation()) || (hasContent && this.acceptRegexp(/^[\w-]/))) {
			hasContent = true;
			if (this.hasWhitespace()) {
				break;
			}
		}
		return hasContent ? this.finish(node) : null;
	}

	public _parseTermExpression(): nodes.Node | null {
		return this._parseModuleMember() ||
			this._parseVariable() ||
			this._parseNestingSelector() ||
			//this._tryParsePrio() ||
			super._parseTermExpression();
	}

	public _parseInterpolation(): nodes.Node | null {
		if (this.peek(scssScanner.InterpolationFunction)) {
			const node = this.create(nodes.Interpolation);
			this.consumeToken();
			if (!node.addChild(this._parseExpr()) && !this._parseNestingSelector()) {
				if (this.accept(TokenType.CurlyR)) {
					return this.finish(node);
				}
				return this.finish(node, ParseError.ExpressionExpected);
			}
			if (!this.accept(TokenType.CurlyR)) {
				return this.finish(node, ParseError.RightCurlyExpected);
			}
			return this.finish(node);
		}
		return null;
	}

	public _parseOperator(): nodes.Node | null {
		if (this.peek(scssScanner.EqualsOperator) || this.peek(scssScanner.NotEqualsOperator)
			|| this.peek(scssScanner.GreaterEqualsOperator) || this.peek(scssScanner.SmallerEqualsOperator)
			|| this.peekDelim('>') || this.peekDelim('<')
			|| this.peekIdent('and') || this.peekIdent('or')
			|| this.peekDelim('%')
		) {
			const node = this.createNode(nodes.NodeType.Operator);
			this.consumeToken();
			return this.finish(node);
		}
		return super._parseOperator();
	}

	public _parseUnaryOperator(): nodes.Node | null {
		if (this.peekIdent('not')) {
			const node = this.create(nodes.Node);
			this.consumeToken();
			return this.finish(node);
		}
		return super._parseUnaryOperator();
	}

	public _parseRuleSetDeclaration(): nodes.Node | null {
		if (this.peek(TokenType.AtKeyword)) {
			return this._parseKeyframe() // nested @keyframe
				|| this._parseImport() // nested @import
				|| this._parseMedia(true) // nested @media
				|| this._parseFontFace() // nested @font-face
				|| this._parseWarnAndDebug() // @warn, @debug and @error statements
				|| this._parseControlStatement() // @if, @while, @for, @each
				|| this._parseFunctionDeclaration() // @function
				|| this._parseExtends() // @extends
				|| this._parseMixinReference() // @include
				|| this._parseMixinContent() // @content
				|| this._parseMixinDeclaration() // nested @mixin
				|| this._parseRuleset(true) // @at-rule
				|| this._parseSupports(true) // @supports
				|| this._parseLayer() // @layer
				|| this._parsePropertyAtRule() // @property
				|| this._parseRuleSetDeclarationAtStatement();
		}
		return this._parseVariableDeclaration() // variable declaration
			|| this._tryParseRuleset(true) // nested ruleset
			|| this._parseDeclaration(); // try css ruleset declaration as last so in the error case, the ast will contain a declaration
	}

	public _parseDeclaration(stopTokens?: TokenType[]): nodes.Declaration | null {
		const custonProperty = this._tryParseCustomPropertyDeclaration(stopTokens);
		if (custonProperty) {
			return custonProperty;
		}

		const node = <nodes.Declaration>this.create(nodes.Declaration);
		if (!node.setProperty(this._parseProperty())) {
			return null;
		}

		if (!this.accept(TokenType.Colon)) {
			return this.finish(node, ParseError.ColonExpected, [TokenType.Colon], stopTokens || [TokenType.SemiColon]);
		}
		if (this.prevToken) {
			node.colonPosition = this.prevToken.offset;
		}

		let hasContent = false;
		if (node.setValue(this._parseExpr())) {
			hasContent = true;
			node.addChild(this._parsePrio());
		}
		if (this.peek(TokenType.CurlyL)) {
			node.setNestedProperties(this._parseNestedProperties());
		} else {
			if (!hasContent) {
				return this.finish(node, ParseError.PropertyValueExpected);
			}
		}
		if (this.peek(TokenType.SemiColon)) {
			node.semicolonPosition = this.token.offset; // not part of the declaration, but useful information for code assist
		}
		return this.finish(node);
	}

	public _parseNestedProperties(): nodes.NestedProperties {
		const node = <nodes.NestedProperties>this.create(nodes.NestedProperties);
		return this._parseBody(node, this._parseDeclaration.bind(this));
	}

	public _parseExtends(): nodes.Node | null {
		if (this.peekKeyword('@extend')) {
			const node = <nodes.ExtendsReference>this.create(nodes.ExtendsReference);
			this.consumeToken();
			if (!node.getSelectors().addChild(this._parseSimpleSelector())) {
				return this.finish(node, ParseError.SelectorExpected);
			}
			while (this.accept(TokenType.Comma)) {
				node.getSelectors().addChild(this._parseSimpleSelector());
			}
			if (this.accept(TokenType.Exclamation)) {
				if (!this.acceptIdent('optional')) {
					return this.finish(node, ParseError.UnknownKeyword);
				}
			}
			return this.finish(node);
		}
		return null;
	}

	public _parseSimpleSelectorBody(): nodes.Node | null {
		return this._parseSelectorPlaceholder() || super._parseSimpleSelectorBody();
	}

	public _parseNestingSelector(): nodes.Node | null {
		if (this.peekDelim('&')) {
			const node = this.createNode(nodes.NodeType.SelectorCombinator);
			this.consumeToken();
			while (!this.hasWhitespace() && (this.acceptDelim('-') || this.accept(TokenType.Num) || this.accept(TokenType.Dimension) || node.addChild(this._parseIdent()) || this.acceptDelim('&'))) {
				//  support &-foo-1
			}
			return this.finish(node);
		}
		return null;
	}

	public _parseSelectorPlaceholder(): nodes.Node | null {
		if (this.peekDelim('%')) {
			const node = this.createNode(nodes.NodeType.SelectorPlaceholder);
			this.consumeToken();
			this._parseIdent();
			return this.finish(node);
		} else if (this.peekKeyword('@at-root')) {
			const node = this.createNode(nodes.NodeType.SelectorPlaceholder);
			this.consumeToken();
			if (this.accept(TokenType.ParenthesisL)) {
				if (!this.acceptIdent('with') && !this.acceptIdent('without')) {
					return this.finish(node, ParseError.IdentifierExpected);
				}
				if (!this.accept(TokenType.Colon)) {
					return this.finish(node, ParseError.ColonExpected);
				}
				if (!node.addChild(this._parseIdent())) {
					return this.finish(node, ParseError.IdentifierExpected);
				}
				if (!this.accept(TokenType.ParenthesisR)) {
					return this.finish(node, ParseError.RightParenthesisExpected, [TokenType.CurlyR]);
				}
			}
			return this.finish(node);
		}
		return null;
	}

	public _parseElementName(): nodes.Node | null {
		const pos = this.mark();
		const node = super._parseElementName();
		if (node && !this.hasWhitespace() && this.peek(TokenType.ParenthesisL)) { // for #49589
			this.restoreAtMark(pos);
			return null;
		}
		return node;
	}

	public _tryParsePseudoIdentifier(): nodes.Node | null {
		return this._parseInterpolation() || super._tryParsePseudoIdentifier(); // for #49589
	}

	public _parseWarnAndDebug(): nodes.Node | null {
		if (!this.peekKeyword('@debug')
			&& !this.peekKeyword('@warn')
			&& !this.peekKeyword('@error')) {
			return null;
		}
		const node = this.createNode(nodes.NodeType.Debug);
		this.consumeToken(); // @debug, @warn or @error
		node.addChild(this._parseExpr()); // optional
		return this.finish(node);
	}

	public _parseControlStatement(parseStatement: () => nodes.Node | null = this._parseRuleSetDeclaration.bind(this)): nodes.Node | null {
		if (!this.peek(TokenType.AtKeyword)) {
			return null;
		}
		return this._parseIfStatement(parseStatement) || this._parseForStatement(parseStatement)
			|| this._parseEachStatement(parseStatement) || this._parseWhileStatement(parseStatement);
	}

	public _parseIfStatement(parseStatement: () => nodes.Node | null): nodes.Node | null {
		if (!this.peekKeyword('@if')) {
			return null;
		}
		return this._internalParseIfStatement(parseStatement);
	}

	private _internalParseIfStatement(parseStatement: () => nodes.Node | null): nodes.IfStatement {
		const node = <nodes.IfStatement>this.create(nodes.IfStatement);
		this.consumeToken(); // @if or if
		if (!node.setExpression(this._parseExpr(true))) {
			return this.finish(node, ParseError.ExpressionExpected);
		}
		this._parseBody(node, parseStatement);
		if (this.acceptKeyword('@else')) {
			if (this.peekIdent('if')) {
				node.setElseClause(this._internalParseIfStatement(parseStatement));
			} else if (this.peek(TokenType.CurlyL)) {
				const elseNode = <nodes.BodyDeclaration>this.create(nodes.ElseStatement);
				this._parseBody(elseNode, parseStatement);
				node.setElseClause(elseNode);
			}
		}
		return this.finish(node);
	}

	public _parseForStatement(parseStatement: () => nodes.Node | null): nodes.Node | null {
		if (!this.peekKeyword('@for')) {
			return null;
		}

		const node = <nodes.ForStatement>this.create(nodes.ForStatement);
		this.consumeToken(); // @for
		if (!node.setVariable(this._parseVariable())) {
			return this.finish(node, ParseError.VariableNameExpected, [TokenType.CurlyR]);
		}
		if (!this.acceptIdent('from')) {
			return this.finish(node, SCSSParseError.FromExpected, [TokenType.CurlyR]);
		}
		if (!node.addChild(this._parseBinaryExpr())) {
			return this.finish(node, ParseError.ExpressionExpected, [TokenType.CurlyR]);
		}
		if (!this.acceptIdent('to') && !this.acceptIdent('through')) {
			return this.finish(node, SCSSParseError.ThroughOrToExpected, [TokenType.CurlyR]);
		}
		if (!node.addChild(this._parseBinaryExpr())) {
			return this.finish(node, ParseError.ExpressionExpected, [TokenType.CurlyR]);
		}

		return this._parseBody(node, parseStatement);
	}

	public _parseEachStatement(parseStatement: () => nodes.Node | null): nodes.Node | null {
		if (!this.peekKeyword('@each')) {
			return null;
		}

		const node = <nodes.EachStatement>this.create(nodes.EachStatement);
		this.consumeToken(); // @each
		const variables = node.getVariables();
		if (!variables.addChild(this._parseVariable())) {
			return this.finish(node, ParseError.VariableNameExpected, [TokenType.CurlyR]);
		}
		while (this.accept(TokenType.Comma)) {
			if (!variables.addChild(this._parseVariable())) {
				return this.finish(node, ParseError.VariableNameExpected, [TokenType.CurlyR]);
			}
		}
		this.finish(variables);
		if (!this.acceptIdent('in')) {
			return this.finish(node, SCSSParseError.InExpected, [TokenType.CurlyR]);
		}
		if (!node.addChild(this._parseExpr())) {
			return this.finish(node, ParseError.ExpressionExpected, [TokenType.CurlyR]);
		}

		return this._parseBody(node, parseStatement);
	}

	public _parseWhileStatement(parseStatement: () => nodes.Node | null): nodes.Node | null {
		if (!this.peekKeyword('@while')) {
			return null;
		}

		const node = <nodes.WhileStatement>this.create(nodes.WhileStatement);
		this.consumeToken(); // @while
		if (!node.addChild(this._parseBinaryExpr())) {
			return this.finish(node, ParseError.ExpressionExpected, [TokenType.CurlyR]);
		}

		return this._parseBody(node, parseStatement);
	}

	public _parseFunctionBodyDeclaration(): nodes.Node | null {
		return this._parseVariableDeclaration() || this._parseReturnStatement() || this._parseWarnAndDebug()
			|| this._parseControlStatement(this._parseFunctionBodyDeclaration.bind(this));
	}

	public _parseFunctionDeclaration(): nodes.Node | null {
		if (!this.peekKeyword('@function')) {
			return null;
		}

		const node = <nodes.FunctionDeclaration>this.create(nodes.FunctionDeclaration);
		this.consumeToken(); // @function

		if (!node.setIdentifier(this._parseIdent([nodes.ReferenceType.Function]))) {
			return this.finish(node, ParseError.IdentifierExpected, [TokenType.CurlyR]);
		}

		if (!this.accept(TokenType.ParenthesisL)) {
			return this.finish(node, ParseError.LeftParenthesisExpected, [TokenType.CurlyR]);
		}

		if (node.getParameters().addChild(this._parseParameterDeclaration())) {
			while (this.accept(TokenType.Comma)) {
				if (this.peek(TokenType.ParenthesisR)) {
					break;
				}
				if (!node.getParameters().addChild(this._parseParameterDeclaration())) {
					return this.finish(node, ParseError.VariableNameExpected);
				}
			}
		}

		if (!this.accept(TokenType.ParenthesisR)) {
			return this.finish(node, ParseError.RightParenthesisExpected, [TokenType.CurlyR]);
		}

		return this._parseBody(node, this._parseFunctionBodyDeclaration.bind(this));
	}

	public _parseReturnStatement(): nodes.Node | null {
		if (!this.peekKeyword('@return')) {
			return null;
		}

		const node = this.createNode(nodes.NodeType.ReturnStatement);
		this.consumeToken(); // @function

		if (!node.addChild(this._parseExpr())) {
			return this.finish(node, ParseError.ExpressionExpected);
		}
		return this.finish(node);
	}

	public _parseMixinDeclaration(): nodes.Node | null {
		if (!this.peekKeyword('@mixin')) {
			return null;
		}

		const node = <nodes.MixinDeclaration>this.create(nodes.MixinDeclaration);
		this.consumeToken();

		if (!node.setIdentifier(this._parseIdent([nodes.ReferenceType.Mixin]))) {
			return this.finish(node, ParseError.IdentifierExpected, [TokenType.CurlyR]);
		}

		if (this.accept(TokenType.ParenthesisL)) {
			if (node.getParameters().addChild(this._parseParameterDeclaration())) {
				while (this.accept(TokenType.Comma)) {
					if (this.peek(TokenType.ParenthesisR)) {
						break;
					}
					if (!node.getParameters().addChild(this._parseParameterDeclaration())) {
						return this.finish(node, ParseError.VariableNameExpected);
					}
				}
			}

			if (!this.accept(TokenType.ParenthesisR)) {
				return this.finish(node, ParseError.RightParenthesisExpected, [TokenType.CurlyR]);
			}
		}

		return this._parseBody(node, this._parseRuleSetDeclaration.bind(this));
	}

	public _parseParameterDeclaration(): nodes.Node | null {

		const node = <nodes.FunctionParameter>this.create(nodes.FunctionParameter);

		if (!node.setIdentifier(this._parseVariable())) {
			return null;
		}

		if (this.accept(scssScanner.Ellipsis)) {
			// ok
		}

		if (this.accept(TokenType.Colon)) {
			if (!node.setDefaultValue(this._parseExpr(true))) {
				return this.finish(node, ParseError.VariableValueExpected, [], [TokenType.Comma, TokenType.ParenthesisR]);
			}
		}
		return this.finish(node);
	}

	public _parseMixinContent(): nodes.Node | null {
		if (!this.peekKeyword('@content')) {
			return null;
		}
		const node = this.create(nodes.MixinContentReference);
		this.consumeToken();
		if (this.accept(TokenType.ParenthesisL)) {
			if (node.getArguments().addChild(this._parseFunctionArgument())) {
				while (this.accept(TokenType.Comma)) {
					if (this.peek(TokenType.ParenthesisR)) {
						break;
					}
					if (!node.getArguments().addChild(this._parseFunctionArgument())) {
						return this.finish(node, ParseError.ExpressionExpected);
					}
				}
			}

			if (!this.accept(TokenType.ParenthesisR)) {
				return this.finish(node, ParseError.RightParenthesisExpected);
			}
		}
		return this.finish(node);
	}


	public _parseMixinReference(): nodes.Node | null {
		if (!this.peekKeyword('@include')) {
			return null;
		}

		const node = <nodes.MixinReference>this.create(nodes.MixinReference);
		this.consumeToken();

		// Could be module or mixin identifier, set as mixin as default.
		const firstIdent = this._parseIdent([nodes.ReferenceType.Mixin]);
		if (!node.setIdentifier(firstIdent)) {
			return this.finish(node, ParseError.IdentifierExpected, [TokenType.CurlyR]);
		}

		// Is a module accessor.
		if (!this.hasWhitespace() && this.acceptDelim('.') && !this.hasWhitespace()) {
			const secondIdent = this._parseIdent([nodes.ReferenceType.Mixin]);

			if (!secondIdent) {
				return this.finish(node, ParseError.IdentifierExpected, [TokenType.CurlyR]);
			}

			const moduleToken = <nodes.Module>this.create(nodes.Module);
			// Re-purpose first matched ident as identifier for module token.
			firstIdent.referenceTypes = [nodes.ReferenceType.Module];
			moduleToken.setIdentifier(firstIdent);

			// Override identifier with second ident.
			node.setIdentifier(secondIdent);
			node.addChild(moduleToken);
		}

		if (this.accept(TokenType.ParenthesisL)) {
			if (node.getArguments().addChild(this._parseFunctionArgument())) {
				while (this.accept(TokenType.Comma)) {
					if (this.peek(TokenType.ParenthesisR)) {
						break;
					}
					if (!node.getArguments().addChild(this._parseFunctionArgument())) {
						return this.finish(node, ParseError.ExpressionExpected);
					}
				}
			}

			if (!this.accept(TokenType.ParenthesisR)) {
				return this.finish(node, ParseError.RightParenthesisExpected);
			}
		}

		if (this.peekIdent('using') || this.peek(TokenType.CurlyL)) {
			node.setContent(this._parseMixinContentDeclaration());
		}
		return this.finish(node);
	}

	public _parseMixinContentDeclaration() {
		const node = <nodes.MixinContentDeclaration>this.create(nodes.MixinContentDeclaration);
		if (this.acceptIdent('using')) {
			if (!this.accept(TokenType.ParenthesisL)) {
				return this.finish(node, ParseError.LeftParenthesisExpected, [TokenType.CurlyL]);
			}
			if (node.getParameters().addChild(this._parseParameterDeclaration())) {
				while (this.accept(TokenType.Comma)) {
					if (this.peek(TokenType.ParenthesisR)) {
						break;
					}
					if (!node.getParameters().addChild(this._parseParameterDeclaration())) {
						return this.finish(node, ParseError.VariableNameExpected);
					}
				}
			}

			if (!this.accept(TokenType.ParenthesisR)) {
				return this.finish(node, ParseError.RightParenthesisExpected, [TokenType.CurlyL]);
			}
		}

		if (this.peek(TokenType.CurlyL)) {
			this._parseBody(node, this._parseMixinReferenceBodyStatement.bind(this));
		}

		return this.finish(node);
	}

	public _parseMixinReferenceBodyStatement(): nodes.Node | null {
		return this._tryParseKeyframeSelector() || this._parseRuleSetDeclaration();
	}

	public _parseFunctionArgument(): nodes.Node | null {
		// [variableName ':'] expression | variableName '...'
		const node = <nodes.FunctionArgument>this.create(nodes.FunctionArgument);

		const pos = this.mark();
		const argument = this._parseVariable();
		if (argument) {
			if (!this.accept(TokenType.Colon)) {
				if (this.accept(scssScanner.Ellipsis)) { // optional
					node.setValue(argument);
					return this.finish(node);
				} else {
					this.restoreAtMark(pos);
				}
			} else {
				node.setIdentifier(argument);
			}
		}

		if (node.setValue(this._parseExpr(true))) {
			this.accept(scssScanner.Ellipsis); // #43746
			node.addChild(this._parsePrio()); // #9859
			return this.finish(node);
		} else if (node.setValue(this._tryParsePrio())) {
			return this.finish(node);
		}

		return null;
	}

	public _parseURLArgument(): nodes.Node | null {
		const pos = this.mark();
		const node = super._parseURLArgument();
		if (!node || !this.peek(TokenType.ParenthesisR)) {
			this.restoreAtMark(pos);

			const node = this.create(nodes.Node);
			node.addChild(this._parseBinaryExpr());
			return this.finish(node);
		}
		return node;
	}

	public _parseOperation(): nodes.Node | null {
		if (!this.peek(TokenType.ParenthesisL)) {
			return null;
		}
		const node = this.create(nodes.Node);
		this.consumeToken();

		while (node.addChild(this._parseListElement())) {
			this.accept(TokenType.Comma); // optional
		}
		if (!this.accept(TokenType.ParenthesisR)) {
			return this.finish(node, ParseError.RightParenthesisExpected);
		}
		return this.finish(node);
	}

	public _parseListElement(): nodes.Node | null {
		const node = <nodes.ListEntry>this.create(nodes.ListEntry);
		const child = this._parseBinaryExpr();
		if (!child) {
			return null;
		}
		if (this.accept(TokenType.Colon)) {
			node.setKey(child);
			if (!node.setValue(this._parseBinaryExpr())) {
				return this.finish(node, ParseError.ExpressionExpected);
			}
		} else {
			node.setValue(child);
		}
		return this.finish(node);
	}

	public _parseUse(): nodes.Node | null {
		if (!this.peekKeyword('@use')) {
			return null;
		}

		const node = <nodes.Use>this.create(nodes.Use);
		this.consumeToken(); // @use

		if (!node.addChild(this._parseStringLiteral())) {
			return this.finish(node, ParseError.StringLiteralExpected);
		}

		if (!this.peek(TokenType.SemiColon) && !this.peek(TokenType.EOF)) {
			if (!this.peekRegExp(TokenType.Ident, /as|with/)) {
				return this.finish(node, ParseError.UnknownKeyword);
			}

			if (
				this.acceptIdent('as') &&
				(!node.setIdentifier(this._parseIdent([nodes.ReferenceType.Module])) && !this.acceptDelim('*'))
			) {
				return this.finish(node, ParseError.IdentifierOrWildcardExpected);
			}

			if (this.acceptIdent('with')) {
				if (!this.accept(TokenType.ParenthesisL)) {
					return this.finish(node, ParseError.LeftParenthesisExpected, [TokenType.ParenthesisR]);
				}

				// First variable statement, no comma.
				if (!node.getParameters().addChild(this._parseModuleConfigDeclaration())) {
					return this.finish(node, ParseError.VariableNameExpected);
				}

				while (this.accept(TokenType.Comma)) {
					if (this.peek(TokenType.ParenthesisR)) {
						break;
					}
					if (!node.getParameters().addChild(this._parseModuleConfigDeclaration())) {
						return this.finish(node, ParseError.VariableNameExpected);
					}
				}

				if (!this.accept(TokenType.ParenthesisR)) {
					return this.finish(node, ParseError.RightParenthesisExpected);
				}

			}
		}

		if (!this.accept(TokenType.SemiColon) && !this.accept(TokenType.EOF)) {
			return this.finish(node, ParseError.SemiColonExpected);
		}

		return this.finish(node);
	}

	public _parseModuleConfigDeclaration(): nodes.Node | null {

		const node = <nodes.ModuleConfiguration>this.create(nodes.ModuleConfiguration);

		if (!node.setIdentifier(this._parseVariable())) {
			return null;
		}

		if (!this.accept(TokenType.Colon) || !node.setValue(this._parseExpr(true))) {
			return this.finish(node, ParseError.VariableValueExpected, [], [TokenType.Comma, TokenType.ParenthesisR]);
		}

		if (this.accept(TokenType.Exclamation)) {
			if (this.hasWhitespace() || !this.acceptIdent('default')) {
				return this.finish(node, ParseError.UnknownKeyword);
			}
		}

		return this.finish(node);
	}

	public _parseForward(): nodes.Node | null {
		if (!this.peekKeyword('@forward')) {
			return null;
		}

		const node = <nodes.Forward>this.create(nodes.Forward);
		this.consumeToken();

		if (!node.addChild(this._parseStringLiteral())) {
			return this.finish(node, ParseError.StringLiteralExpected);
		}

		if (this.acceptIdent('as')) {
			const identifier = this._parseIdent([nodes.ReferenceType.Forward]);
			if (!node.setIdentifier(identifier)) {
				return this.finish(node, ParseError.IdentifierExpected);
			}

			// Wildcard must be the next character after the identifier string.
			if (this.hasWhitespace() || !this.acceptDelim('*')) {
				return this.finish(node, ParseError.WildcardExpected);
			}
		}

		if (this.acceptIdent('with')) {
			if (!this.accept(TokenType.ParenthesisL)) {
				return this.finish(node, ParseError.LeftParenthesisExpected, [TokenType.ParenthesisR]);
			}

			// First variable statement, no comma.
			if (!node.getParameters().addChild(this._parseModuleConfigDeclaration())) {
				return this.finish(node, ParseError.VariableNameExpected);
			}

			while (this.accept(TokenType.Comma)) {
				if (this.peek(TokenType.ParenthesisR)) {
					break;
				}
				if (!node.getParameters().addChild(this._parseModuleConfigDeclaration())) {
					return this.finish(node, ParseError.VariableNameExpected);
				}
			}

			if (!this.accept(TokenType.ParenthesisR)) {
				return this.finish(node, ParseError.RightParenthesisExpected);
			}

		} else if (this.peekIdent('hide') || this.peekIdent('show')) {
			if (!node.addChild(this._parseForwardVisibility())) {
				return this.finish(node, ParseError.IdentifierOrVariableExpected);
			}
		}

		if (!this.accept(TokenType.SemiColon) && !this.accept(TokenType.EOF)) {
			return this.finish(node, ParseError.SemiColonExpected);
		}

		return this.finish(node);
	}

	public _parseForwardVisibility(): nodes.Node | null {
		const node = <nodes.ForwardVisibility>this.create(nodes.ForwardVisibility);

		// Assume to be "hide" or "show".
		node.setIdentifier(this._parseIdent());

		while (node.addChild(this._parseVariable() || this._parseIdent())) {
			// Consume all variables and idents ahead.
			this.accept(TokenType.Comma);
		}

		// More than just identifier 
		return node.getChildren().length > 1 ? node : null;
	}

	protected _parseSupportsCondition(): nodes.Node {
		return this._parseInterpolation() || super._parseSupportsCondition();
	}

}
