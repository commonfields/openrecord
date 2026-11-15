#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

// A document renderer, never an application browser. It has no app cookies,
// persistent storage, script execution, popups, or external navigation.
@interface ORPreviewPolicy : NSObject <WKNavigationDelegate>
@end
@implementation ORPreviewPolicy
- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))done {
    NSString *url = action.request.URL.absoluteString;
    done(([url isEqualToString:@"about:blank"] || [url isEqualToString:@"about:srcdoc"]) ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
@end
static WKWebView *preview;
static ORPreviewPolicy *policy;
static NSString *document;
// The document has painted once: until then the view stays transparent, so
// the card's own "Rendering document" shows instead of a blank white flash.
static BOOL painted;
static BOOL animate = YES;

// Fades the view up once it is on screen and its document has painted.
static void reveal(void) {
    if (!preview || preview.hidden || !painted || preview.alphaValue >= 1.0) return;
    if (!animate) { preview.alphaValue = 1.0; return; }
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
        context.duration = 0.18;
        context.timingFunction = [CAMediaTimingFunction functionWithControlPoints:0.4 :0.0 :0.2 :1.0];
        preview.animator.alphaValue = 1.0;
    } completionHandler:nil];
}

@implementation ORPreviewPolicy (Reveal)
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    painted = YES;
    reveal();
}
@end

// Hidden at once: a menu or dialog drawn by the app must never sit under it.
void or_preview_hide(void) { [preview setHidden:YES]; preview.alphaValue = 0.0; }
void or_preview_clear(void) { [preview stopLoading]; [preview removeFromSuperview]; preview = nil; policy = nil; document = nil; painted = NO; }

void or_preview_show(const char *html, double x, double y, double w, double h, int motion) {
    animate = motion != 0;
    NSWindow *window = NSApp.mainWindow ?: NSApp.keyWindow;
    // During initial layout or while the app is inactive, Cocoa can have no
    // main/key window. OpenRecord has one document window; use its visible host.
    if (!window) for (NSWindow *candidate in NSApp.windows) {
        if (candidate.visible && candidate.canBecomeMainWindow) { window = candidate; break; }
    }
    if (!window || w <= 0 || h <= 0) return;
    NSView *host = window.contentView;
    if (!preview) {
        WKWebViewConfiguration *config = [WKWebViewConfiguration new];
        config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        // WebKit needs its document engine to load srcdoc on older macOS.
        // Artifact scripts are refused by the sandbox and both CSP policies.
        config.preferences.javaScriptCanOpenWindowsAutomatically = NO;
        preview = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:config];
        preview.alphaValue = 0.0;
        policy = [ORPreviewPolicy new];
        preview.navigationDelegate = policy;
        preview.allowsBackForwardNavigationGestures = NO;
    }
    if (preview.superview != host) { [preview removeFromSuperview]; [host addSubview:preview]; }
    CGFloat top = host.isFlipped ? y : host.bounds.size.height - y - h;
    NSRect frame = NSMakeRect(x, top, w, h);
    if (!NSEqualRects(preview.frame, frame)) [preview setFrame:frame];
    NSString *next = [NSString stringWithUTF8String:html];
    if (![next isEqualToString:document]) {
        // Another version keeps the one on screen until it has painted.
        document = next;
        if (preview.hidden || preview.alphaValue < 1.0) painted = NO;
        [preview loadHTMLString:next baseURL:nil];
    }
    if (preview.hidden) { preview.alphaValue = 0.0; [preview setHidden:NO]; }
    reveal();
}

#import <AuthenticationServices/AuthenticationServices.h>
@interface ORAuthorizationAnchor : NSObject <ASWebAuthenticationPresentationContextProviding>
@end
@implementation ORAuthorizationAnchor
- (ASPresentationAnchor)presentationAnchorForWebAuthenticationSession:(ASWebAuthenticationSession *)session { return NSApp.mainWindow; }
@end
static ASWebAuthenticationSession *authorization;
static ORAuthorizationAnchor *anchor;
static int authorizationResult;
static NSUInteger authorizationGeneration;
void or_oauth_cancel(void) { authorizationGeneration++; [authorization cancel]; authorization = nil; authorizationResult = 0; }
int or_oauth_result(void) { int result = authorizationResult; authorizationResult = 0; return result; }
void or_oauth_start(const char *raw) {
    or_oauth_cancel();
    NSUInteger generation = authorizationGeneration;
    NSURL *url = [NSURL URLWithString:[NSString stringWithUTF8String:raw]];
    if (!url) { authorizationResult = -1; return; }
    authorization = [[ASWebAuthenticationSession alloc] initWithURL:url callbackURLScheme:@"openrecord" completionHandler:^(NSURL *callback, NSError *error) {
        if (generation != authorizationGeneration) return;
        NSURLComponents *parts = callback ? [NSURLComponents componentsWithURL:callback resolvingAgainstBaseURL:NO] : nil;
        BOOL ok = NO;
        for (NSURLQueryItem *item in parts.queryItems) if ([item.name isEqualToString:@"status"] && [item.value isEqualToString:@"connected"]) ok = YES;
        authorizationResult = (!error && ok) ? 1 : -1;
        authorization = nil;
    }];
    anchor = [ORAuthorizationAnchor new];
    authorization.presentationContextProvider = anchor;
    authorization.prefersEphemeralWebBrowserSession = YES;
    if (![authorization start]) { authorizationResult = -1; authorization = nil; }
}

// ---- The side panel's browser -----------------------------------------------
// A separate, ordinary web view for the side panel's Browser tab. It shares
// nothing with the document renderer above: its own non-persistent data store
// (no app session, no cookies kept between launches), web pages only (http and
// https), and a page's "open in a new window" loads in place instead.
// The folder of the app's own copies of artifact pages: the one place on disk
// the browser may open, so a page the agent wrote shows as a page.
static NSURL *pagesFolder;
static BOOL inPages(NSURL *url) {
    return url.isFileURL && pagesFolder && [url.URLByStandardizingPath.path hasPrefix:[pagesFolder.URLByStandardizingPath.path stringByAppendingString:@"/"]];
}
// Reads the colour behind the page's foot, where the chat box floats, so the
// box can take the page's light or dark look.
static NSMutableDictionary<NSNumber *, NSNumber *> *browserLight;
static NSMutableDictionary<NSNumber *, WKWebView *> *browsers;
static void probeLight(WKWebView *view) {
    NSString *js = @"(function(){function c(e){while(e&&e.nodeType===1){var m=(getComputedStyle(e).backgroundColor.match(/[\\d.]+/g)||[]).map(Number);if(m.length>=3&&(m.length<4||m[3]>0.5))return m;e=e.parentElement}return null}var e=document.elementFromPoint(innerWidth/2,Math.max(0,innerHeight-40));var m=c(e)||c(document.body)||c(document.documentElement);if(!m)return 1;return(0.299*m[0]+0.587*m[1]+0.114*m[2])>140?1:0})()";
    NSNumber *key = [[browsers allKeysForObject:view] firstObject];
    if (!key) return;
    [view evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        if (!error && [result isKindOfClass:[NSNumber class]]) {
            if (!browserLight) browserLight = [NSMutableDictionary new];
            browserLight[key] = result;
        }
    }];
}
@interface ORBrowserPolicy : NSObject <WKNavigationDelegate, WKUIDelegate>
@end
@implementation ORBrowserPolicy
- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))done {
    NSString *scheme = action.request.URL.scheme.lowercaseString;
    BOOL web = [scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"] || [scheme isEqualToString:@"about"] || inPages(action.request.URL);
    done(web ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    probeLight(view);
}
- (WKWebView *)webView:(WKWebView *)view createWebViewWithConfiguration:(WKWebViewConfiguration *)config forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    if (action.request.URL) [view loadRequest:action.request];
    return nil;
}
@end
static WKWebView *browser;
static ORBrowserPolicy *browserPolicy;
// One web view per browser tab, kept while the tab is open so its page and
// history survive switching; `browser` is the tab in front.
static int browserId;
static char browserURL[4096];
// The app's view the browser sits behind, and the places on the page the app
// draws over and keeps its clicks for (the floating chat box), in its points.
static NSView *browserHost;
// The page sits in a box of the panel's colour: the page is rounded on every
// corner, the box only at the foot where the panel itself is rounded, so the
// page's top corners show the panel and its foot follows the panel's curve.
static NSView *browserBox;
static NSColor *browserPanel;
static BOOL browserPassThrough = YES;
static NSRect browserKeep[4];
static int browserKeeps;
static IMP hostHitTest;

// Over the page, a click or scroll goes to the page; over what the app draws
// on it, to the app.
static NSView *hostHitTestThrough(NSView *self, SEL cmd, NSPoint point) {
    if (self == browserHost && browserPassThrough && browserBox && !browserBox.hidden && browserBox.superview == self.superview && NSPointInRect(point, browserBox.frame)) {
        NSPoint local = [self convertPoint:point fromView:self.superview];
        CGFloat y = self.isFlipped ? local.y : self.bounds.size.height - local.y;
        BOOL kept = NO;
        for (int i = 0; i < browserKeeps; i++) if (NSPointInRect(NSMakePoint(local.x, y), browserKeep[i])) kept = YES;
        if (!kept) return [browserBox hitTest:point] ?: [browser hitTest:point];
    }
    return ((NSView *(*)(NSView *, SEL, NSPoint))hostHitTest)(self, cmd, point);
}
static void passThrough(NSView *host) {
    if (hostHitTest) return;
    Class cls = object_getClass(host);
    SEL sel = @selector(hitTest:);
    Method m = class_getInstanceMethod(cls, sel);
    hostHitTest = method_getImplementation(m);
    // Its own override, so no other view's hit testing changes.
    if (!class_addMethod(cls, sel, (IMP)hostHitTestThrough, method_getTypeEncoding(m))) hostHitTest = method_setImplementation(m, (IMP)hostHitTestThrough);
}

// Clicks on the page since the app last asked: the app's own fields never
// see them, so the address bar learns of them here to stop editing.
static int pageClicks;
static id clickMonitor;
static void watchClicks(void) {
    if (clickMonitor) return;
    clickMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown handler:^NSEvent *(NSEvent *e) {
        if (browserBox && !browserBox.hidden && e.window == browserBox.window) {
            NSPoint p = [browserBox.superview convertPoint:e.locationInWindow fromView:nil];
            if (NSPointInRect(p, browserBox.frame)) {
                BOOL kept = NO;
                if (browserHost) {
                    NSPoint local = [browserHost convertPoint:e.locationInWindow fromView:nil];
                    CGFloat y = browserHost.isFlipped ? local.y : browserHost.bounds.size.height - local.y;
                    for (int i = 0; i < browserKeeps; i++) if (NSPointInRect(NSMakePoint(local.x, y), browserKeep[i])) kept = YES;
                }
                if (!kept) pageClicks++;
            }
        }
        return e;
    }];
}
int or_browser_take_click(void) { int n = pageClicks; pageClicks = 0; return n > 0 ? 1 : 0; }

// Whether clicks over the page reach it: not while a menu or dialog is open.
void or_browser_pass_through(int on) { browserPassThrough = on != 0; }

// The panel's colour, behind the page's rounded corners.
void or_browser_backdrop(double r, double g, double b) {
    NSColor *c = [NSColor colorWithSRGBRed:r green:g blue:b alpha:1.0];
    if ([c isEqual:browserPanel]) return;
    browserPanel = c;
    if (browserBox) browserBox.layer.backgroundColor = c.CGColor;
}

// The places the app draws over the page, in window points from the top left.
void or_browser_keep(const double *rects, int count) {
    browserKeeps = count < 0 ? 0 : (count > 4 ? 4 : count);
    for (int i = 0; i < browserKeeps; i++) browserKeep[i] = NSMakeRect(rects[i * 4], rects[i * 4 + 1], rects[i * 4 + 2], rects[i * 4 + 3]);
}

// The window's own colour, which shows wherever the app leaves its view clear.
void or_window_background(double r, double g, double b) {
    NSWindow *window = NSApp.mainWindow ?: NSApp.keyWindow;
    if (!window) for (NSWindow *candidate in NSApp.windows) {
        if (candidate.visible && candidate.canBecomeMainWindow) { window = candidate; break; }
    }
    NSColor *c = [NSColor colorWithSRGBRed:r green:g blue:b alpha:1.0];
    if (window && ![window.backgroundColor isEqual:c]) window.backgroundColor = c;
}

void or_browser_hide(void) { [browserBox setHidden:YES]; }

// Forgets one tab's page.
void or_browser_drop(int id) {
    WKWebView *v = browsers[@(id)];
    [v stopLoading];
    [v removeFromSuperview];
    [browsers removeObjectForKey:@(id)];
    [browserLight removeObjectForKey:@(id)];
    if (id == browserId) { browser = nil; browserURL[0] = 0; }
}

// The tab in front closes its page (back to the start list).
void or_browser_close(void) { or_browser_drop(browserId); browserKeeps = 0; [browserBox setHidden:YES]; }

// Brings another tab's page to the front; it loads on the next show.
void or_browser_select(int id) {
    if (id == browserId) return;
    [browser removeFromSuperview];
    browserId = id;
    browser = browsers[@(id)];
    if (browser && browserBox) { [browserBox addSubview:browser]; [browser setFrame:browserBox.bounds]; }
}

// The page's own zoom, apart from the app's.
void or_browser_zoom(double zoom) {
    if (@available(macOS 11.0, *)) { if (browser && browser.pageZoom != zoom) browser.pageZoom = zoom; }
}

// 1 light, 0 dark, -1 not known; asks again for next time.
int or_browser_page_light(void) {
    if (browser) probeLight(browser);
    NSNumber *n = browserLight[@(browserId)];
    return n ? n.intValue : -1;
}

// Places the browser at the rect (window points, top-left origin) and, when
// `url` is given and differs from what it shows, loads it.
void or_browser_show(const char *url, double x, double y, double w, double h) {
    NSWindow *window = NSApp.mainWindow ?: NSApp.keyWindow;
    if (!window) for (NSWindow *candidate in NSApp.windows) {
        if (candidate.visible && candidate.canBecomeMainWindow) { window = candidate; break; }
    }
    if (!window || w <= 0 || h <= 0) return;
    NSView *host = window.contentView;
    if (!browser) {
        WKWebViewConfiguration *config = [WKWebViewConfiguration new];
        config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        config.preferences.javaScriptCanOpenWindowsAutomatically = NO;
        browser = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:config];
        if (!browserPolicy) browserPolicy = [ORBrowserPolicy new];
        browser.navigationDelegate = browserPolicy;
        browser.UIDelegate = browserPolicy;
        browser.allowsBackForwardNavigationGestures = YES;
        browser.wantsLayer = YES;
        browser.layer.cornerRadius = 10.0;
        browser.layer.masksToBounds = YES;
        browser.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        if (!browsers) browsers = [NSMutableDictionary new];
        browsers[@(browserId)] = browser;
    }
    if (!browserBox) {
        browserBox = [[NSView alloc] initWithFrame:NSZeroRect];
        browserBox.wantsLayer = YES;
        browserBox.layer.cornerRadius = 10.0;
        // Unflipped layer: min Y is the foot.
        browserBox.layer.maskedCorners = kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner;
        browserBox.layer.masksToBounds = YES;
        if (browserPanel) browserBox.layer.backgroundColor = browserPanel.CGColor;
    }
    if (browser.superview != browserBox) { [browser removeFromSuperview]; [browserBox addSubview:browser]; }
    // Behind the app's own view, not on it: the app draws over the page (the
    // chat box floats on it) and leaves the rest of the page's place clear.
    NSView *frameView = host.superview;
    if (browserBox.superview != frameView) { [browserBox removeFromSuperview]; [frameView addSubview:browserBox positioned:NSWindowBelow relativeTo:host]; }
    passThrough(host);
    browserHost = host;
    watchClicks();
    CGFloat top = host.isFlipped ? y : host.bounds.size.height - y - h;
    NSRect frame = [host convertRect:NSMakeRect(x, top, w, h) toView:frameView];
    if (!NSEqualRects(browserBox.frame, frame)) { [browserBox setFrame:frame]; [browser setFrame:browserBox.bounds]; }
    if (url && url[0]) {
        NSURL *next = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
        if (next && ![next isEqual:browser.URL]) {
            if (next.isFileURL) {
                pagesFolder = next.URLByDeletingLastPathComponent;
                [browser loadFileURL:next allowingReadAccessToURL:pagesFolder];
            } else {
                [browser loadRequest:[NSURLRequest requestWithURL:next]];
            }
        }
    }
    if (browserBox.hidden) [browserBox setHidden:NO];
}

// 1 back, 2 forward, 3 reload, 4 stop.
void or_browser_command(int command) {
    switch (command) {
        case 1: [browser goBack]; break;
        case 2: [browser goForward]; break;
        case 3: [browser reload]; break;
        case 4: [browser stopLoading]; break;
    }
}

// What the browser shows now, for the address bar; empty before it loads.
const char *or_browser_url(void) {
    NSString *u = browser.URL.absoluteString ?: @"";
    strlcpy(browserURL, u.UTF8String ?: "", sizeof browserURL);
    return browserURL;
}
int or_browser_state(void) { return (browser.canGoBack ? 1 : 0) | (browser.canGoForward ? 2 : 0) | (browser.loading ? 4 : 0); }

