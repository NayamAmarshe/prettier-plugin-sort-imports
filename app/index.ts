import { parsers as typescriptParsers } from 'prettier/parser-typescript';
import { parsers as babelParsers } from 'prettier/parser-babel';
import { sortBlockAlphabetically } from './sorters/alphabetical';
import { PrettierOptions, SORTING_TYPE } from './types';
import { sortBlockByLength } from './sorters/by-length';
import * as ts from 'typescript';
import { validateOptions } from './options';
import {
	generateImportSorter,
	ImportTypeSorter,
	OrderGroup,
} from './sorters/import-type';
export { options } from './options';

const CACHE_REFRESH_INTERVAL = 1000 * 60 * 2.5;

function countStringAppearances(str: string, char: string) {
	let count: number = 0;
	while (str.includes(char)) {
		count++;
		let index = str.indexOf(char);
		str = str.slice(0, index) + str.slice(index + 1);
	}
	return count;
}

export type TSImportStatement = ts.ImportDeclaration | ts.VariableStatement;

export interface SingleImport {
	import: TSImportStatement;
	isTypeOnly: boolean;
	importPath: string;
	start: number;
	end: number;
}

export const importNewline = Symbol('importNewline');

export type ImportBlock = SingleImport[];
export type ImportBlockWithGroups = (
	| SingleImport[]
	| OrderGroup<SingleImport[]>
)[];

function getLastTrailingComment(fullText: string, tsImport: TSImportStatement) {
	const comments = ts.getTrailingCommentRanges(
		fullText,
		tsImport.getFullStart() + tsImport.getFullWidth()
	);
	if (!comments) {
		return null;
	}
	return comments[comments.length - 1];
}

function getFirstLeadingComment(fullText: string, tsImport: TSImportStatement) {
	const comments = ts.getLeadingCommentRanges(
		fullText,
		tsImport.getFullStart()
	);
	if (!comments) {
		return null;
	}
	return comments[0];
}

function getImportRanges(
	blocks: ImportBlock[],
	fullText: string,
	tsImport: TSImportStatement,
	importPath: string,
	isTypeOnly: boolean
): SingleImport {
	const currentBlock = blocks[blocks.length - 1];
	const index = currentBlock.length;
	let start = index === 0 ? tsImport.getStart() : tsImport.getFullStart();
	if (index === 0 && tsImport.getFullStart() !== 0) {
		start--;
	}
	const leadingComment = getFirstLeadingComment(fullText, tsImport);
	if (leadingComment && !commentIsIgnoreComment(fullText, leadingComment)) {
		if (index !== 0) {
			start = leadingComment.pos - 1;
		}
	}

	const lastBlockChild = currentBlock[currentBlock.length - 1];
	const prevLastComment =
		lastBlockChild &&
		getLastTrailingComment(fullText, lastBlockChild.import);
	if (
		lastBlockChild &&
		prevLastComment &&
		!commentIsIgnoreComment(fullText, prevLastComment)
	) {
		start =
			prevLastComment.end +
			~~(prevLastComment.hasTrailingNewLine ?? false);
	}
	let end = tsImport.getFullStart() + tsImport.getFullWidth();
	const lastComment = getLastTrailingComment(fullText, tsImport);
	if (lastComment) {
		end = lastComment.end;
		if (lastComment.hasTrailingNewLine) {
			end += 1;
		}
	}
	return {
		import: tsImport,
		start: Math.max(start, 0),
		importPath,
		end,
		isTypeOnly,
	};
}

function isInRange(
	start: number,
	end: number,
	ranges: IgnoredRange[]
): boolean {
	for (const range of ranges) {
		if (
			(end >= range.start && end < range.end) ||
			(start >= range.start && start < range.end)
		) {
			return true;
		}
	}
	return false;
}

function commentIsIgnoreComment(
	text: string,
	comment: ts.CommentRange
): boolean {
	const commentText = text.slice(comment.pos, comment.end);
	return (
		commentText.includes(IGNORE_BEGIN) || commentText.includes(IGNORE_END)
	);
}

function getImportPath(tsImport: TSImportStatement) {
	if (ts.isImportDeclaration(tsImport)) {
		return tsImport.moduleSpecifier.getText();
	} else {
		if (tsImport.declarationList.declarations.length !== 1) {
			return null;
		}
		const declaration = tsImport.declarationList.declarations[0];
		if (!ts.isVariableDeclaration(declaration)) {
			return null;
		}

		const initializer = declaration.initializer;
		if (!initializer || !ts.isCallExpression(initializer)) {
			return null;
		}

		return initializer.arguments[0].getText();
	}
}

// Find all "blocks" of imports. These are just lines of imports
// without any newlines between them
function findImportBlocks(
	file: ts.SourceFile,
	stripNewlines: boolean,
	ignoredRanges: IgnoredRange[]
): ImportBlock[] {
	const blocks: ImportBlock[] = [[]];
	const rootChildren =
		file.getChildren()[0].kind === ts.SyntaxKind.SyntaxList
			? file.getChildren()[0].getChildren()
			: file.getChildren();

	let lastDeclaration: TSImportStatement | null = null;
	for (const child of rootChildren) {
		if (
			ts.isImportDeclaration(child) ||
			(ts.isVariableStatement(child) &&
				child.declarationList &&
				child.declarationList.declarations.length === 1 &&
				ts.isVariableDeclaration(
					child.declarationList.declarations[0]
				) &&
				child.declarationList.declarations[0].initializer &&
				ts.isCallExpression(
					child.declarationList.declarations[0].initializer
				) &&
				child.declarationList.declarations[0].initializer.expression.getText() ===
					'require')
		) {
			if (lastDeclaration) {
				let startIndex: number = child.getStart();
				let endIndex: number = lastDeclaration.getEnd();
				const leadingComments = ts.getLeadingCommentRanges(
					file.getFullText(),
					child.getFullStart()
				);
				const trailingComments = ts.getTrailingCommentRanges(
					file.getFullText(),
					lastDeclaration.getEnd()
				);
				if (leadingComments && leadingComments.length) {
					// Has comments before it
					startIndex = leadingComments[0].pos;
				}
				if (trailingComments && trailingComments.length) {
					const lastTrailingComment =
						trailingComments[trailingComments.length - 1];
					endIndex = lastTrailingComment.end;
				}
				const textBetween = file
					.getFullText()
					.slice(endIndex, startIndex);

				if (isInRange(startIndex, child.getEnd(), ignoredRanges)) {
					// Ignore this
					blocks.push([]);
					lastDeclaration = child;
					continue;
				}

				if (stripNewlines) {
					if (
						textBetween
							.split('')
							.filter(
								(c) => c !== '\n' && c !== '\t' && c !== ' '
							).length > 0
					) {
						// non-newlines in between, new block
						blocks.push([]);
					}
					// By just ignoring the newlines and not re-printing them
					// we're getting rid of them
				} else if (countStringAppearances(textBetween, '\n') > 1) {
					// New block
					blocks.push([]);
				}
			}
			const importPath = getImportPath(child);
			if (importPath) {
				blocks[blocks.length - 1].push(
					getImportRanges(
						blocks,
						file.getFullText(),
						child,
						importPath,
						!!(
							ts.isImportDeclaration(child) &&
							child.importClause?.isTypeOnly
						)
					)
				);
			}
			lastDeclaration = child;
		}
	}

	return blocks.filter((block) => block.length > 0);
}

function transformLines(
	lines: (string | typeof importNewline)[],
	options: PrettierOptions
): (string | typeof importNewline)[] {
	return lines
		.map((b) => {
			if (b === importNewline) {
				return b;
			}
			if (!b.startsWith('\n')) {
				return `\n${b}`;
			}
			return b;
		})
		.map((b) => {
			if (b === importNewline) {
				return b;
			}
			if (options.stripNewlines) {
				while (b.startsWith('\n')) {
					b = b.slice(1);
				}
				return `\n${b}`;
			}
			return b;
		})
		.map((b) => {
			if (b === importNewline) {
				return b;
			}
			if (b.endsWith('\n')) {
				return b.slice(0, -1);
			}
			return b;
		});
}

function trimSpaces(line: string) {
	while (line.startsWith(' ') || line.startsWith('\t')) {
		line = line.slice(1);
	}
	while (line.endsWith(' ') || line.endsWith('\t')) {
		line = line.slice(0, -1);
	}
	return line;
}

function sortBlockImports(
	block: ImportBlock,
	options: PrettierOptions,
	importTypeSorter: ImportTypeSorter
) {
	const presorted = importTypeSorter ? importTypeSorter(block) : [block];
	const sorterFunction =
		options.sortingMethod === SORTING_TYPE.ALPHABETICAL
			? sortBlockAlphabetically
			: sortBlockByLength;
	const sorted = presorted.map((block) => {
		if (block instanceof OrderGroup) {
			return new OrderGroup(block.values.map(sorterFunction));
		} else {
			return sorterFunction(block);
		}
	});
	let flattened: (SingleImport | typeof importNewline)[] = [];
	for (let i = 0; i < sorted.length; i++) {
		const sortedBlock = sorted[i];
		if (sortedBlock instanceof OrderGroup) {
			for (const subgroup of sortedBlock.values) {
				flattened = flattened.concat(subgroup);
			}
		} else {
			flattened = flattened.concat(sortedBlock as ImportBlock);
		}
		if (options.newlineBetweenTypes && i < sorted.length - 1) {
			flattened.push(importNewline);
		}
	}
	return flattened;
}

function sortBlock(
	block: ImportBlock,
	fullText: string,
	options: PrettierOptions,
	importTypeSorter: ImportTypeSorter
): string {
	if (block.length === 0) {
		return fullText;
	}

	const sorted = sortBlockImports(block, options, importTypeSorter);

	const blockLines = transformLines(
		sorted.map((s) =>
			s === importNewline
				? importNewline
				: trimSpaces(fullText.slice(s.start, s.end))
		),
		options
	).map((line) => (line === importNewline ? '\n' : line));
	let blockText = blockLines.join('');
	const lastBlock = block[block.length - 1];
	let lastBlockEnd =
		lastBlock.import.getFullStart() + lastBlock.import.getFullWidth();
	const trailingComments = ts.getTrailingCommentRanges(
		fullText,
		lastBlockEnd
	);
	if (trailingComments) {
		lastBlockEnd = trailingComments[trailingComments.length - 1].end;
		if (trailingComments[trailingComments.length - 1].hasTrailingNewLine) {
			if (!blockText.endsWith('\n')) {
				blockText += '\n';
			}
			lastBlockEnd += 1;
		}
	}
	if (block[0].import.getFullStart() === 0 && blockText.startsWith('\n')) {
		blockText = blockText.slice(1);
	}
	return (
		fullText.slice(0, block[0].start) +
		blockText +
		fullText.slice(lastBlock.end)
	);
}

interface IgnoredRange {
	start: number;
	end: number;
}

const IGNORE_BEGIN = 'sort-imports-begin-ignore';
const IGNORE_BEGIN_COMMENTS = [`//${IGNORE_BEGIN}`, `// ${IGNORE_BEGIN}`];
const IGNORE_END = 'sort-imports-end-ignore';
const IGNORE_END_COMMENTS = [`//${IGNORE_END}`, `// ${IGNORE_END}`];

function getIndexOfAny(text: string, options: string[]): number {
	for (const option of options) {
		const index = text.indexOf(option);
		if (index !== -1) {
			return index;
		}
	}
	return -1;
}

function checkIgnoreCounts(
	fileName: string | undefined,
	text: string
): boolean {
	const ignoreStartCount = IGNORE_BEGIN_COMMENTS.reduce(
		(prev, cmt) => prev + countStringAppearances(text, cmt),
		0
	);
	const ignoreEndCount = IGNORE_END_COMMENTS.reduce(
		(prev, cmt) => prev + countStringAppearances(text, cmt),
		0
	);
	if (ignoreStartCount !== ignoreEndCount) {
		console.warn(
			`Number of ignore begin and end comments do not match in file "${
				fileName ?? 'input'
			}". Found ${ignoreStartCount} begin comments and ${ignoreEndCount} end comments. Skipping file`
		);
		return false;
	}
	return true;
}

function lineAt(text: string, offset: number): number {
	const lines = text.split('\n');
	let currentOffset = 0;
	for (let i = 0; i < lines.length; i++) {
		const lineLength = lines[i].length;
		if (currentOffset + lineLength > offset) {
			return i;
		}
		currentOffset += lineLength;
	}
	return -1;
}

function getIgnoredRanges(text: string): IgnoredRange[] | null {
	const ranges: IgnoredRange[] = [];
	if (getIndexOfAny(text, IGNORE_BEGIN_COMMENTS) === -1) {
		return [];
	}

	const originalText = text;
	let offset = 0;
	let beginIndex: number;
	while ((beginIndex = getIndexOfAny(text, IGNORE_BEGIN_COMMENTS)) !== -1) {
		const rangeStart = offset + beginIndex;
		offset = offset + beginIndex + IGNORE_BEGIN_COMMENTS[0].length;
		text = text.slice(offset);
		const endIndex = getIndexOfAny(text, IGNORE_END_COMMENTS);

		if (endIndex === -1) {
			console.warn(
				`Failed to find end ignore comment for ignore begin comment on line ${lineAt(
					originalText,
					rangeStart
				)}, ignoring file`
			);
			return null;
		}

		ranges.push({
			start: rangeStart,
			end: offset + endIndex,
		});

		offset = offset + endIndex + IGNORE_END_COMMENTS[0].length;
		text = text.slice(offset);
	}

	return ranges;
}

interface InitResult {
	importTypeSorter: ImportTypeSorter;
}

let initResult: InitResult | null = null;
let hasCacheClearTimer: boolean = false;
function ensureInit(options: PrettierOptions): InitResult {
	if (initResult && !process.argv.includes('--sort-imports-reinit')) {
		return initResult;
	}

	if (hasCacheClearTimer) {
		const timer = setInterval(() => {
			initResult = null;
		}, CACHE_REFRESH_INTERVAL);
		timer.unref();
	}

	validateOptions(options);

	initResult = {
		importTypeSorter: generateImportSorter(options),
	};
	return initResult;
}

/**
 * Organize the imports
 */
function sortImports(text: string, options: PrettierOptions) {
	if (
		text.includes('// sort-imports-ignore') ||
		text.includes('//sort-imports-ignore') ||
		!checkIgnoreCounts(options.filepath, text)
	) {
		return text;
	}

	const initData = ensureInit(options);

	const ignoredRanges = getIgnoredRanges(text);
	if (ignoredRanges === null) {
		return text;
	}

	const fileName = options.filepath || 'file.ts';

	const file = ts.createSourceFile(
		fileName,
		text,
		ts.ScriptTarget.Latest,
		true,
		fileName.endsWith('ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX
	);

	const blocks = findImportBlocks(
		file,
		options.stripNewlines,
		ignoredRanges
	).reverse();
	for (const block of blocks) {
		text = sortBlock(block, text, options, initData.importTypeSorter);
	}

	return text;
}

export const parsers = {
	typescript: {
		...typescriptParsers.typescript,
		preprocess: typescriptParsers.typescript.preprocess
			? (text: string, options: PrettierOptions) => {
					return sortImports(
						typescriptParsers.typescript.preprocess!(text, options),
						options
					);
			  }
			: sortImports,
	},
	babel: {
		...babelParsers.babel,
		preprocess: babelParsers.babel.preprocess
			? (text: string, options: PrettierOptions) => {
					return sortImports(
						babelParsers.babel.preprocess!(text, options),
						options
					);
			  }
			: sortImports,
	},
};
