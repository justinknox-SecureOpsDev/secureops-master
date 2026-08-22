"use strict";

const fs = require("node:fs");
const upstream = require("image-size-upstream");

function asBytes(input) {
  if (typeof input === "string") {
    return fs.readFileSync(input);
  }

  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    return input;
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  throw new TypeError("Expected an image path, Buffer, Uint8Array, or ArrayBuffer");
}

function startsWith(bytes, signature) {
  return signature.every((byte, index) => bytes[index] === byte);
}

function isJxlOrIsoBmff(bytes) {
  // JPEG XL can be a raw codestream or an ISO-BMFF box. HEIF/AVIF files use
  // ISO-BMFF too. The upstream image-size parser has no patched release for
  // their zero-length-box infinite-loop vulnerability, so do not parse them.
  return (
    startsWith(bytes, [0xff, 0x0a]) ||
    (bytes.length >= 8 &&
      (bytes.subarray(4, 8).toString("ascii") === "JXL " ||
        bytes.subarray(4, 8).toString("ascii") === "ftyp"))
  );
}

function imageSize(input, callback) {
  try {
    const bytes = asBytes(input);
    if (isJxlOrIsoBmff(bytes)) {
      throw new TypeError(
        "JPEG XL and ISO-BMFF image parsing is disabled for security",
      );
    }

    const dimensions = upstream.imageSize(bytes);
    if (typeof callback === "function") {
      callback(null, dimensions);
      return;
    }
    return dimensions;
  } catch (error) {
    if (typeof callback === "function") {
      callback(error);
      return;
    }
    throw error;
  }
}

module.exports = imageSize;
module.exports.imageSize = imageSize;
module.exports.disableTypes = upstream.disableTypes;
module.exports.types = upstream.types;