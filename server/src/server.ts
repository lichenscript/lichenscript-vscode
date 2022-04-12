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
  CompletionParams,
  CompletionItem,
  DefinitionParams,
  NotificationType
  // CompletionItemKind
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createIntellisenseInstance, IntellisenseInstantce } from "lichenscript-web";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { fsProvider } from "./dummyFS";
import { getSearchPathFromNode } from "./utils";

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

function pathFromUri(uri: string): string | undefined {
  if (uri.startsWith('file://')) {
    return uri.slice('file://'.length);
  }
  return undefined;
}

let runtimeDir: string;
let stdDir: string;

interface IntellisenseWrapper {
  instance: IntellisenseInstantce;
  hasError: boolean;
}

const modulesMap: Map<string, IntellisenseWrapper> = new Map();

connection.onInitialize( async (params: InitializeParams) => {
  try {
    runtimeDir = await getRuntimeDir();
    stdDir = await getStdDir();
  } catch(e) {
    console.error(e);
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
        resolveProvider: false,
        triggerCharacters: ['.'],
      },
      definitionProvider: true,
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

connection.onInitialized(async () => {
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

  if (!runtimeDir || !stdDir) {
    connection.sendNotification(new ShowErrorMessage, {
      content: "Please install LichenScript, it's not installed on your OS."
    });
  }
});

connection.onDefinition((params: DefinitionParams) => {
  try {
    const filePath = pathFromUri(params.textDocument.uri);
    if (typeof filePath === 'undefined') {
      return undefined;
    }
    const document = documents.get(params.textDocument.uri);
    if (typeof document === 'undefined') {
      return undefined;
    }
    const dirPath = path.dirname(filePath);
    const intellisenseWrapper = modulesMap.get(dirPath);
    if (!intellisenseWrapper) {
      return undefined;
    }
    const offset = document.offsetAt(params.position);
    const tmp = intellisenseWrapper.instance.findDefinition(filePath, offset);
    return tmp;
  } catch (err) {
    console.error(err);
    return undefined;
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

let debounceTicket: NodeJS.Timeout | undefined = undefined;
let debouncedEvent: TextDocumentChangeEvent<TextDocument> | undefined = undefined

documents.onDidChangeContent((e: TextDocumentChangeEvent<TextDocument>) => {
  if (debounceTicket) {
    clearTimeout(debounceTicket);
  }
  debouncedEvent = e;
  debounceTicket = setTimeout(() => {
    handleDocumentChanged(e);
    debounceTicket = undefined;
    debouncedEvent = undefined;
  }, 300);
});

function initIntellisenseInstantce(dirPath: string): IntellisenseWrapper | undefined {
  let wrapper = modulesMap.get(dirPath);
  if (wrapper) {
    return wrapper;
  }
  if (!runtimeDir || !stdDir) {
    console.log("runtimeDir or stdDir are undefined");
    return undefined;
  }
  console.log('init module: ', dirPath);
  const findPaths = getSearchPathFromNode(dirPath);
  const instance = createIntellisenseInstance(fsProvider, {
    findPaths: [stdDir, ...findPaths],
    runtimeDir,
    precludeDir: stdDir
  } as any);
  wrapper = { instance, hasError: false };
  modulesMap.set(dirPath, wrapper);
  return wrapper;
}

function handleDocumentChanged(e: TextDocumentChangeEvent<TextDocument>) {
  const textDocument = e.document;
  const filePath = pathFromUri(e.document.uri);
  if (typeof filePath === 'undefined') {
    return undefined;
  }
  const dirPath = path.dirname(filePath);
  const intellisenseWrapper = initIntellisenseInstantce(dirPath);
  if (!intellisenseWrapper) {
    return;
  }
  const content = textDocument.getText();
  const diagnostics = intellisenseWrapper.instance.parseAndCache(filePath, content) as Diagnostic[];

  let hasError = false;

  for (const d of diagnostics) {
    if (d.severity === DiagnosticSeverity.Error) {
      hasError = true;
      break;
    }
  }

  if (hasError) {
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
    intellisenseWrapper.hasError = true;
    return;
  }

  // only warnings or others

  const typecheckDiagnostics: Diagnostic[] = intellisenseWrapper.instance.typecheckDir(dirPath) as Diagnostic[];
  console.log('typecheckDiagnostics: ', typecheckDiagnostics);

  let typecheckHasError = false;
  for (const d of typecheckDiagnostics) {
    if (d.severity === DiagnosticSeverity.Error) {
      typecheckHasError = true;
      intellisenseWrapper.hasError = true;
    }
    diagnostics.push(d);
  }

  intellisenseWrapper.hasError = typecheckHasError;

  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// connection.onDidChangeWatchedFiles(_change => {
//   // Monitored files have change in VSCode
//   connection.console.log('We received an file change event');
// });

// This handler provides the initial list of the completion items.
connection.onCompletion(
  (params: CompletionParams): CompletionItem[] | undefined => {
    if (debounceTicket) {
      clearTimeout(debounceTicket);
      handleDocumentChanged(debouncedEvent!);
      debounceTicket = undefined;
      debouncedEvent = undefined;
    }

    try {
      const filePath = pathFromUri(params.textDocument.uri);
      if (typeof filePath === 'undefined') {
        console.log("1");
        return undefined;
      }
      const document = documents.get(params.textDocument.uri);
      if (typeof document === 'undefined') {
        console.log("2");
        return undefined;
      }
      const dirPath = path.dirname(filePath);
      const intellisenseWrapper = modulesMap.get(dirPath);
      if (!intellisenseWrapper) {
        console.log("3");
        return undefined;
      }
      // if (intellisenseWrapper.hasError) {
      //   console.log("4");
      //   return undefined;
      // }
      const offset = document.offsetAt(params.position);
      const tmp = intellisenseWrapper.instance.findCompletion(filePath, offset);
      console.log("ret: ", tmp);
      return tmp;
    } catch (err) {
      console.error(err);
      return undefined;
    }
  }
);

// // This handler resolves additional information for the item selected in
// // the completion list.
// connection.onCompletionResolve(
//   (item: CompletionItem): CompletionItem => {
//     // if (item.data === 1) {
//     //   item.detail = 'TypeScript details';
//     //   item.documentation = 'TypeScript documentation';
//     // } else if (item.data === 2) {
//     //   item.detail = 'JavaScript details';
//     //   item.documentation = 'JavaScript documentation';
//     // }
//     return item;
//   }
// );

documents.listen(connection);

// Listen on the connection
connection.listen();
