import {
  createConnection,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  Diagnostic,
  DiagnosticSeverity,
  TextDocumentSyncKind,
  InitializeResult,
  TextDocuments,
  TextDocumentChangeEvent,
  TextDocumentPositionParams,
  CompletionItem,
  NotificationType
  // CompletionItemKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createIntellisenseInstance, IntellisenseInstantce } from 'lichenscript-web';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { fsProvider } from './dummyFS';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
// let hasDiagnosticRelatedInformationCapability = false;

interface ShowErrorMessageParams {
  content: string,
}

class ShowErrorMessage extends NotificationType<ShowErrorMessageParams> {

  constructor() {
    super("editor/showErrorMessage");
  }

}

const asyncExec = promisify(exec);

async function getRuntimeDir() {
  const { stdout } = await asyncExec('lsc --runtime-path');
  return stdout.replace('\n', '');
}

async function getStdDir() {
  const { stdout } = await asyncExec('lsc --std-path');
  return stdout.replace('\n', '');
}

function pathFromUri(uri: string) {
  if (uri.startsWith('file://')) {
    return uri.slice('file://'.length);
  }
  return uri;
}

let runtimeDir: string;
let stdDir: string;

const modulesMap: Map<string, IntellisenseInstantce> = new Map();

connection.onInitialize(async (params: InitializeParams) => {
  try {
    runtimeDir = await getRuntimeDir();
    stdDir = await getStdDir();
  } catch(e) {
    console.error(e);
    connection.sendNotification(new ShowErrorMessage, {
      content: "Please install lsc first, it's not installed on your OS."
    });
    throw e;
  }

  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  // hasDiagnosticRelatedInformationCapability = !!(
  //   capabilities.textDocument &&
  //   capabilities.textDocument.publishDiagnostics &&
  //   capabilities.textDocument.publishDiagnostics.relatedInformation
  // );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: ['.']
      }
    }
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true
      }
    };
  }
  return result;
});

connection.onInitialized(() => {
  console.log('server initialized...');
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }

  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(_event => {
      connection.console.log('Workspace folder change event received.');
    });
  }
});

connection.onExit(() => {
  console.log('connection exiting...');
});

documents.onDidOpen((e: TextDocumentChangeEvent<TextDocument>) => {
  const filePath = pathFromUri(e.document.uri);
  console.log('open file: ', filePath);
  handleDocumentChanged(e);
});

documents.onDidClose((e: TextDocumentChangeEvent<TextDocument>) => {
  const filePath = pathFromUri(e.document.uri);
  console.log('close file: ', filePath);
});

documents.onDidChangeContent((e: TextDocumentChangeEvent<TextDocument>) => {
  handleDocumentChanged(e);
});

function initIntellisenseInstantce(dirPath: string): IntellisenseInstantce {
  let instance = modulesMap.get(dirPath);
  if (instance) {
    return instance;
  }
  console.log('init module: ', dirPath);
  instance = createIntellisenseInstance(fsProvider, {
    findPaths: [stdDir],
    runtimeDir,
  });
  modulesMap.set(dirPath, instance);
  return instance;
}

function handleDocumentChanged(e: TextDocumentChangeEvent<TextDocument>) {
  const textDocument = e.document;
  const filePath = pathFromUri(e.document.uri);
  const dirPath = path.dirname(filePath);
  const intellisenseInstantce = initIntellisenseInstantce(dirPath);
  const content = textDocument.getText();
  const diagnostics: Diagnostic[] = [];
  try {
    intellisenseInstantce.parseAndCacheWillThrow(filePath, content);
  } catch (err: any) {
    let errors = err.errors;
    if (!Array.isArray(errors)) {
      return
    }
    for (const err of errors) {
      const diagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: err.start[0] - 1, character: err.start[1] },
          end: { line: err.end[0] - 1, character: err.end[1] }
        },
        message: err.content,
        source: err.source
      };

      diagnostics.push(diagnostic);
    }
  }
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// async function validateTextDocument(textDocument: TextDocument): Promise<void> {
//   // In this simple example we get the settings for every validate run.
//   // const settings = await getDocumentSettings(textDocument.uri);

//   // The validator creates diagnostics for all uppercase words length 2 and more
//   const text = textDocument.getText();
//   const pattern = /\b[A-Z]{2,}\b/g;
//   let m: RegExpExecArray | null;

//   const diagnostics: Diagnostic[] = [];
//   while ((m = pattern.exec(text))) {
//     const diagnostic: Diagnostic = {
//       severity: DiagnosticSeverity.Warning,
//       range: {
//         start: textDocument.positionAt(m.index),
//         end: textDocument.positionAt(m.index + m[0].length)
//       },
//       message: `${m[0]} is all uppercase.`,
//       source: 'ex'
//     };
//     if (hasDiagnosticRelatedInformationCapability) {
//       diagnostic.relatedInformation = [
//         {
//           location: {
//             uri: textDocument.uri,
//             range: Object.assign({}, diagnostic.range)
//           },
//           message: 'Spelling matters'
//         },
//         {
//           location: {
//             uri: textDocument.uri,
//             range: Object.assign({}, diagnostic.range)
//           },
//           message: 'Particularly for names'
//         }
//       ];
//     }
//     diagnostics.push(diagnostic);
//   }

//   // Send the computed diagnostics to VSCode.
//   connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
// }

// connection.onDidChangeWatchedFiles(_change => {
//   // Monitored files have change in VSCode
//   connection.console.log('We received an file change event');
// });

// This handler provides the initial list of the completion items.
connection.onCompletion(
  (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    return [
      // {
      //   label: 'TypeScript',
      //   kind: CompletionItemKind.Text,
      //   data: 1
      // },
      // {
      //   label: 'JavaScript',
      //   kind: CompletionItemKind.Text,
      //   data: 2
      // }
    ];
  }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
  (item: CompletionItem): CompletionItem => {
    if (item.data === 1) {
      item.detail = 'TypeScript details';
      item.documentation = 'TypeScript documentation';
    } else if (item.data === 2) {
      item.detail = 'JavaScript details';
      item.documentation = 'JavaScript documentation';
    }
    return item;
  }
);

documents.listen(connection);

// Listen on the connection
connection.listen();
