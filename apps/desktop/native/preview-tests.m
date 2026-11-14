// Real WebKit smoke: render the same isolated document wrapper as the app,
// snapshot it, and prove a hostile script did not replace its blue canvas.
#import "preview.m"
int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 3) return 2;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 480, 320) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        NSString *html = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:argv[1]] encoding:NSUTF8StringEncoding error:nil];
        if (!html) return 3;
        // The test window can be key without being main until the app runs.
        [window makeMainWindow];
        or_preview_show(html.UTF8String, 0, 0, 480, 320, 0);
        if (!preview) { fprintf(stderr, "native preview did not attach to window\n"); return 4; }
        if (preview.configuration.websiteDataStore.persistent) return 4;
        NSDate *until = [NSDate dateWithTimeIntervalSinceNow:4];
        while (until.timeIntervalSinceNow > 0) [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.02]];
        __block BOOL done = NO;
        __block int result = 5;
        [preview takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *error) {
            if (image && !error) {
                NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
                NSColor *color = [[bitmap colorAtX:bitmap.pixelsWide/2 y:bitmap.pixelsHigh/2] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
                NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                [png writeToFile:[NSString stringWithUTF8String:argv[2]] atomically:YES];
                result = color.blueComponent > .8 && color.redComponent < .2 && color.greenComponent < .2 ? 0 : 6;
            }
            done = YES;
        }];
        until = [NSDate dateWithTimeIntervalSinceNow:10];
        while (!done && until.timeIntervalSinceNow > 0) [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.02]];
        or_preview_hide();
        if (!preview.hidden) return 7;
        [window orderOut:nil];
        printf("WebKit isolated rendering: %s\n", result == 0 ? "passed" : "failed");
        return result;
    }
}
