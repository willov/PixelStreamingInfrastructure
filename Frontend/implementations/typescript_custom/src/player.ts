// Copyright Epic Games, Inc. All Rights Reserved.

import { Config, PixelStreaming, Logger, LogLevel, Flags } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.5';
import { Application, PixelStreamingApplicationStyle } from '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.5';
const PixelStreamingApplicationStyles =
    new PixelStreamingApplicationStyle();
PixelStreamingApplicationStyles.applyStyleSheet();

// expose the pixel streaming object for hooking into. tests etc.
declare global {
    interface Window { pixelStreaming: PixelStreaming; }
}

document.body.onload = function() {
    Logger.InitLogging(LogLevel.Warning, false);

    // Create a config object
    const config = new Config({ useUrlParams: true });

    // Set custom settings
    try {
        // Enable hovering mouse mode
        config.setFlagEnabled(Flags.HoveringMouseMode, true);
    } catch (e) {
        console.log('Could not set flags:', e);
    }

    // Create a Native DOM delegate instance that implements the Delegate interface class
    const stream = new PixelStreaming(config);

    const application = new Application({
        stream,
        onColorModeChanged: (isLightMode) => PixelStreamingApplicationStyles.setColorMode(isLightMode)
    });
	// document.getElementById("centrebox").appendChild(application.rootElement);
    document.body.appendChild(application.rootElement);
    
    window.pixelStreaming = stream;
}
