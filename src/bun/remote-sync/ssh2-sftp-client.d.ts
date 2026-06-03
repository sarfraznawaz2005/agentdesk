// Minimal ambient types for `ssh2-sftp-client` (the package ships no bundled .d.ts).
// Covers only the API surface used by src/bun/remote-sync/client.ts.

declare module "ssh2-sftp-client" {
	export interface FileInfoType {
		type: "-" | "d" | "l";
		name: string;
		size: number;
		modifyTime: number;
		accessTime: number;
		rights?: { user: string; group: string; other: string };
		owner?: number;
		group?: number;
		longname?: string;
	}

	export interface StatType {
		mode: number;
		uid: number;
		gid: number;
		size: number;
		accessTime: number;
		modifyTime: number;
		isDirectory: boolean;
		isFile: boolean;
		isBlockDevice: boolean;
		isCharacterDevice: boolean;
		isSymbolicLink: boolean;
		isFIFO: boolean;
		isSocket: boolean;
	}

	export interface ConnectOptions {
		host?: string;
		port?: number;
		username?: string;
		password?: string;
		privateKey?: string | Buffer;
		passphrase?: string;
		readyTimeout?: number;
		retries?: number;
		/** Called with the server host key; return false to reject the connection. */
		hostVerifier?: (key: Buffer) => boolean;
		[key: string]: unknown;
	}

	export default class SftpClient {
		constructor(name?: string);
		connect(options: ConnectOptions): Promise<unknown>;
		list(remotePath: string, filter?: (item: FileInfoType) => boolean): Promise<FileInfoType[]>;
		stat(remotePath: string): Promise<StatType>;
		exists(remotePath: string): Promise<false | "d" | "-" | "l">;
		mkdir(remotePath: string, recursive?: boolean): Promise<string>;
		fastGet(remotePath: string, localPath: string, options?: object): Promise<string>;
		fastPut(localPath: string, remotePath: string, options?: object): Promise<string>;
		get(
			remotePath: string,
			dst?: string | NodeJS.WritableStream,
			options?: object,
		): Promise<Buffer | string | NodeJS.WritableStream>;
		end(): Promise<boolean>;
	}
}
