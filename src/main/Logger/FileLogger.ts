import { createWriteStream, mkdirSync, WriteStream } from "fs";
import { join } from "path";
import { app } from "electron";

import { storage } from "../Storage";
import { Logger } from "./Logger";

export class FileLogger extends Logger {
  private logFilePath: string;
  private stream: WriteStream;

  constructor() {
    super();

    this.logFilePath = join(app.getPath("userData"), "logfile.log");
    mkdirSync(app.getPath("userData"), { recursive: true });
    // One append stream instead of opening the file for every line.
    this.stream = createWriteStream(this.logFilePath, { flags: this.shouldTruncate() ? "w" : "a" });
    this.stream.on("error", (error) => console.error(`Cannot write log to file: ${this.logFilePath}`, error));
  }

  private shouldTruncate() {
    const currentTimestamp = Date.now();

    if (storage.settings.app.lastTimeClearLogFile === 0) {
      storage.settings.app.lastTimeClearLogFile = currentTimestamp;
      storage.save();
    }

    if (storage.settings.app.lastTimeClearLogFile + 8.64e7 <= currentTimestamp) {
      storage.settings.app.lastTimeClearLogFile = currentTimestamp;
      storage.save();
      return true;
    }

    return false;
  }

  public log = (msg: string) => {
    this.stream.write(`${msg}\n`);
  };
}
