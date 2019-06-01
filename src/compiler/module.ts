import path from "path";
import RojoProject from "rojo-utils";
import * as ts from "ts-morph";
import { checkReserved, compileExpression } from ".";
import { CompilerState } from "../CompilerState";
import { CompilerError, CompilerErrorType } from "../errors/CompilerError";
import { isRbxService, isUsedAsType } from "../typeUtilities";
import { isValidLuaIdentifier, stripExtensions, transformPathToLua } from "../utility";

function isDefinitionALet(def: ts.DefinitionInfo<ts.ts.DefinitionInfo>) {
	const parent = def.getNode().getParent();
	if (parent && ts.TypeGuards.isVariableDeclaration(parent)) {
		const grandparent = parent.getParent();
		return (
			ts.TypeGuards.isVariableDeclarationList(grandparent) &&
			grandparent.getDeclarationKind() === ts.VariableDeclarationKind.Let
		);
	}
	return false;
}

function shouldLocalizeImport(namedImport: ts.Identifier) {
	for (const definition of namedImport.getDefinitions()) {
		if (isDefinitionALet(definition)) {
			return false;
		}
	}
	return true;
}

function getRojoUnavailableError(node: ts.Node) {
	return new CompilerError(
		`Failed to load Rojo configuration! Cannot compile ${node.getKindName()}`,
		node,
		CompilerErrorType.BadRojo,
	);
}

function getRelativeImportPath(
	state: CompilerState,
	sourceFile: ts.SourceFile,
	moduleFile: ts.SourceFile | undefined,
	node: ts.Node,
) {
	if (!state.rojoProject) {
		throw getRojoUnavailableError(node);
	}

	const rbxFrom = state.rojoProject.getRbxFromFile(
		transformPathToLua(state.rootDirPath, state.outDirPath, sourceFile.getFilePath()),
	).path;
	const rbxTo = moduleFile
		? state.rojoProject.getRbxFromFile(
				transformPathToLua(state.rootDirPath, state.outDirPath, moduleFile.getFilePath()),
		  ).path
		: [];

	if (!rbxFrom) {
		throw getRojoUnavailableError(node);
	}

	if (!rbxTo) {
		throw getRojoUnavailableError(node);
	}

	const rbxRelative = RojoProject.relative(rbxFrom, rbxTo);

	let start = "script";
	while (rbxRelative[0] === "..") {
		rbxRelative.shift();
		start += ".Parent";
	}

	state.usesTSLibrary = true;
	return `TS.import(${start}, ${rbxRelative.map(v => `"${v}"`).join(", ")})`;
}

const moduleCache = new Map<string, string>();

function getModuleImportPath(state: CompilerState, moduleFile: ts.SourceFile) {
	const x = moduleFile.getFilePath();
	const modulesDir = state.modulesDir!;
	let parts = modulesDir
		.getRelativePathTo(moduleFile)
		.split("/")
		.filter(part => part !== ".");

	const scope = parts.shift()!;
	if (scope !== "@rbxts") {
		throw new CompilerError(
			"Imported packages must have the @rbxts scope!",
			moduleFile,
			CompilerErrorType.BadPackageScope,
		);
	}

	const moduleName = parts.shift()!;

	let mainPath: string;
	if (moduleCache.has(moduleName)) {
		mainPath = moduleCache.get(moduleName)!;
	} else {
		const pkgJson = require(path.join(modulesDir.getPath(), scope, moduleName, "package.json"));
		mainPath = pkgJson.main as string;
		moduleCache.set(moduleName, mainPath);
	}

	parts = mainPath.split(/[\\/]/g);
	const last = stripExtensions(parts.pop()!);
	if (last !== "init") {
		parts.push(last);
	}

	parts = parts.filter(part => part !== ".").map(part => (isValidLuaIdentifier(part) ? "." + part : `["${part}"]`));

	state.usesTSLibrary = true;
	const params = `TS.getModule("${moduleName}")` + parts.join("");
	return `require(${params})`;
}

function getAbsoluteImportPath(state: CompilerState, moduleFile: ts.SourceFile, node: ts.Node) {
	if (!state.rojoProject) {
		throw getRojoUnavailableError(node);
	}

	const filePath = moduleFile.getFilePath();
	const rbx = state.rojoProject.getRbxFromFile(transformPathToLua(state.rootDirPath, state.outDirPath, filePath));
	if (!rbx.path || rbx.path.length === 0) {
		throw new CompilerError(`Could not find Rojo data for ${filePath}`, node, CompilerErrorType.BadRojo);
	}

	const rbxPath = [...rbx.path];

	let service = rbxPath.shift()!;
	if (isRbxService(service)) {
		service = `game:GetService("${service}")`;
	} else {
		throw new CompilerError(`"${service}" is not a valid Roblox Service!`, node, CompilerErrorType.InvalidService);
	}

	state.usesTSLibrary = true;
	return `TS.import(${service}, ${rbxPath.map(v => `"${v}"`).join(", ")})`;
}

function getImportPathFromFile(state: CompilerState, moduleFile: ts.SourceFile, node: ts.Node) {
	if (state.modulesDir && state.modulesDir.isAncestorOf(moduleFile)) {
		return getModuleImportPath(state, moduleFile);
	} else {
		return getAbsoluteImportPath(state, moduleFile, node);
	}
}

export function compileImportDeclaration(state: CompilerState, node: ts.ImportDeclaration) {
	const defaultImport = node.getDefaultImport();
	const namespaceImport = node.getNamespaceImport();
	const namedImports = node.getNamedImports();

	const isRoact =
		(defaultImport && defaultImport.getText() === "Roact") ||
		(namespaceImport && namespaceImport.getText() === "Roact");

	if (isRoact) {
		state.hasRoactImport = true;
	}

	const isSideEffect = !defaultImport && !namespaceImport && namedImports.length === 0;

	if (
		!isRoact &&
		!isSideEffect &&
		(!namespaceImport || isUsedAsType(namespaceImport)) &&
		(!defaultImport || isUsedAsType(defaultImport)) &&
		namedImports.every(namedImport => isUsedAsType(namedImport.getNameNode()))
	) {
		return "";
	}

	let luaPath: string;
	if (node.isModuleSpecifierRelative()) {
		luaPath = getRelativeImportPath(state, node.getSourceFile(), node.getModuleSpecifierSourceFile(), node);
	} else {
		const moduleFile = node.getModuleSpecifierSourceFile();
		if (moduleFile) {
			luaPath = getImportPathFromFile(state, moduleFile, node);
		} else {
			const specifierText = node.getModuleSpecifier().getLiteralText();
			throw new CompilerError(
				`Could not find file for '${specifierText}'. Did you forget to "npm install"?`,
				node,
				CompilerErrorType.MissingModuleFile,
			);
		}
	}

	let result = "";
	if (isSideEffect) {
		return `${luaPath};\n`;
	}

	const lhs = new Array<string>();
	const rhs = new Array<string>();
	const unlocalizedImports = new Array<string>();

	if (defaultImport && (isRoact || !isUsedAsType(defaultImport))) {
		const definitions = defaultImport.getDefinitions();
		const exportAssignments =
			definitions.length > 0 &&
			definitions[0]
				.getNode()
				.getSourceFile()
				.getExportAssignments();

		const defaultImportExp = compileExpression(state, defaultImport);

		if (exportAssignments && exportAssignments.length === 1 && exportAssignments[0].isExportEquals()) {
			// If the defaultImport is importing an `export = ` statement,
			return `local ${defaultImportExp} = ${luaPath};\n`;
		}

		lhs.push(defaultImportExp);
		rhs.push(`._default`);
		unlocalizedImports.push("");
	}

	if (namespaceImport && (isRoact || !isUsedAsType(namespaceImport))) {
		lhs.push(compileExpression(state, namespaceImport));
		rhs.push("");
		unlocalizedImports.push("");
	}

	let rhsPrefix: string;
	let hasVarNames = false;

	namedImports
		.filter(namedImport => !isUsedAsType(namedImport.getNameNode()))
		.forEach(namedImport => {
			const aliasNode = namedImport.getAliasNode();
			const name = namedImport.getName();
			const alias = aliasNode ? aliasNode.getText() : name;
			const shouldLocalize = shouldLocalizeImport(namedImport.getNameNode());

			// keep these here no matter what, so that exports can take from initial state.
			checkReserved(alias, node, true);
			lhs.push(alias);
			rhs.push(`.${name}`);

			if (shouldLocalize) {
				unlocalizedImports.push("");
			} else {
				hasVarNames = true;
				unlocalizedImports.push(alias);
			}
		});

	if (rhs.length === 1 && !hasVarNames) {
		rhsPrefix = luaPath;
	} else {
		rhsPrefix = state.getNewId();
		result += `local ${rhsPrefix} = ${luaPath};\n`;
	}

	for (let i = 0; i < unlocalizedImports.length; i++) {
		const alias = unlocalizedImports[i];
		if (alias !== "") {
			state.variableAliases.set(alias, rhsPrefix + rhs[i]);
		}
	}

	if (hasVarNames || lhs.length > 0) {
		const lhsStr = lhs.join(", ");
		const rhsStr = rhs.map(v => rhsPrefix + v).join(", ");
		result += `local ${lhsStr} = ${rhsStr};\n`;
	}

	return result;
}

export function compileImportEqualsDeclaration(state: CompilerState, node: ts.ImportEqualsDeclaration) {
	const nameNode = node.getNameNode();
	const name = node.getName();

	const isRoact = name === "Roact";
	if (isRoact) {
		state.hasRoactImport = true;
	}

	if (!isRoact && isUsedAsType(nameNode)) {
		return "";
	}

	let luaPath: string;
	const moduleFile = node.getExternalModuleReferenceSourceFile();
	if (moduleFile) {
		if (node.isExternalModuleReferenceRelative()) {
			luaPath = getRelativeImportPath(state, node.getSourceFile(), moduleFile, node);
		} else {
			luaPath = getImportPathFromFile(state, moduleFile, node);
		}
	} else {
		const text = node.getModuleReference().getText();
		throw new CompilerError(`Could not find file for '${text}'`, node, CompilerErrorType.MissingModuleFile);
	}

	return state.indent + `local ${name} = ${luaPath};\n`;
}

export function compileExportDeclaration(state: CompilerState, node: ts.ExportDeclaration) {
	let luaImportStr = "";
	const moduleSpecifier = node.getModuleSpecifier();
	if (moduleSpecifier) {
		if (node.isModuleSpecifierRelative()) {
			luaImportStr = getRelativeImportPath(
				state,
				node.getSourceFile(),
				node.getModuleSpecifierSourceFile(),
				node,
			);
		} else {
			const moduleFile = node.getModuleSpecifierSourceFile();
			if (moduleFile) {
				luaImportStr = getImportPathFromFile(state, moduleFile, node);
			} else {
				const specifierText = moduleSpecifier.getLiteralText();
				throw new CompilerError(
					`Could not find file for '${specifierText}'. Did you forget to "npm install"?`,
					node,
					CompilerErrorType.MissingModuleFile,
				);
			}
		}
	}

	const ancestor =
		node.getFirstAncestorByKind(ts.SyntaxKind.ModuleDeclaration) ||
		node.getFirstAncestorByKind(ts.SyntaxKind.SourceFile);

	if (!ancestor) {
		throw new CompilerError("Could not find export ancestor!", node, CompilerErrorType.BadAncestor);
	}

	const lhs = new Array<string>();
	const rhs = new Array<string>();

	if (node.isNamespaceExport()) {
		state.usesTSLibrary = true;
		let ancestorName: string;
		if (ts.TypeGuards.isNamespaceDeclaration(ancestor)) {
			ancestorName = ancestor.getName();
		} else {
			state.isModule = true;
			ancestorName = "_exports";
		}
		return state.indent + `TS.exportNamespace(${luaImportStr}, ${ancestorName});\n`;
	} else {
		const namedExports = node.getNamedExports().filter(namedExport => !isUsedAsType(namedExport.getNameNode()));
		if (namedExports.length === 0) {
			return "";
		}

		let ancestorName: string;
		if (ts.TypeGuards.isNamespaceDeclaration(ancestor)) {
			ancestorName = ancestor.getName();
		} else {
			state.isModule = true;
			ancestorName = "_exports";
		}

		namedExports.forEach(namedExport => {
			const aliasNode = namedExport.getAliasNode();
			let name = namedExport.getNameNode().getText();
			if (name === "default") {
				name = "_default";
			}
			const alias = aliasNode ? aliasNode.getText() : name;
			checkReserved(alias, node);
			lhs.push(alias);
			if (luaImportStr !== "") {
				rhs.push(`.${name}`);
			} else {
				rhs.push(state.getAlias(name));
			}
		});

		let result = "";
		let rhsPrefix = "";
		const lhsPrefix = ancestorName + ".";
		if (luaImportStr !== "") {
			if (rhs.length <= 1) {
				rhsPrefix = `${luaImportStr}`;
			} else {
				rhsPrefix = state.getNewId();
				result += state.indent + `local ${rhsPrefix} = ${luaImportStr};\n`;
			}
		}
		const lhsStr = lhs.map(v => lhsPrefix + v).join(", ");
		const rhsStr = rhs.map(v => rhsPrefix + v).join(", ");
		result += `${lhsStr} = ${rhsStr};\n`;
		return result;
	}
}

export function compileExportAssignment(state: CompilerState, node: ts.ExportAssignment) {
	const exp = node.getExpression();
	if (node.isExportEquals() && (!ts.TypeGuards.isIdentifier(exp) || !isUsedAsType(exp))) {
		state.isModule = true;
		state.enterPrecedingStatementContext();
		const expStr = compileExpression(state, exp);
		return state.exitPrecedingStatementContextAndJoin() + `_exports = ${expStr};\n`;
	} else {
		const symbol = node.getSymbol();
		if (symbol) {
			if (symbol.getName() === "default") {
				state.isModule = true;
				state.enterPrecedingStatementContext();
				const expStr = compileExpression(state, exp);
				return state.exitPrecedingStatementContextAndJoin() + "_exports._default = " + expStr + ";\n";
			}
		}
	}
	return "";
}
