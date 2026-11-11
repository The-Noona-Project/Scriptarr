package com.scriptarr.raven.downloader;

import java.io.IOException;

/** Successful source response whose image bytes are damaged, independently of transport availability. */
final class SourceImageDataException extends IOException {
    /**
     * Describe source damage that may use the explicit page-quality path after bounded retries.
     * @param message source damage diagnostic
     */
    SourceImageDataException(String message) {
        super(message);
    }
}
