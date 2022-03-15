import { FSProvider } from "lichenscript-web";
import * as fs from "fs";
import { resolve } from "path";

export const fsProvider: FSProvider = {
  isDirectory(path: string): boolean {
    try {
      const stat = fs.statSync(path)
      return stat.isDirectory();
    } catch (e) {
      return false;
    }
  },

  isFile(path: string): boolean {
    try {
      const stat = fs.statSync(path)
      return stat.isFile();
    } catch (e) {
      return false;
    }
  },

  getRealPath(path: string): string {
    return resolve(path);
  },

  lsDir(path: string): string[] {
    return fs.readdirSync(path);
  },

  mkdirRecursive(path: string) {
    fs.mkdirSync(path, { recursive: true });
  },

  fileExists(path: string): boolean {
    try {
      const stat = fs.statSync(path)
      return stat.isFile();
    } catch (e) {
      return false;
    }
  },

  readFileContent(path: string): string {
    return fs.readFileSync(path, 'utf8');
  },

  writeFileContent(path: string) {
    return fs.writeFileSync(path, arguments[1]);
  },

}
