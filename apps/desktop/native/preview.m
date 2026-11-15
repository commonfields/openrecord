#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>

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
@interface ORBrowserPolicy : NSObject <WKNavigationDelegate, WKUIDelegate>
@end
@implementation ORBrowserPolicy
- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))done {
    NSString *scheme = action.request.URL.scheme.lowercaseString;
    BOOL web = [scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"] || [scheme isEqualToString:@"about"];
    done(web ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (WKWebView *)webView:(WKWebView *)view createWebViewWithConfiguration:(WKWebViewConfiguration *)config forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    if (action.request.URL) [view loadRequest:action.request];
    return nil;
}
@end
static WKWebView *browser;
static ORBrowserPolicy *browserPolicy;
static char browserURL[4096];

void or_browser_hide(void) { [browser setHidden:YES]; }
void or_browser_close(void) { [browser stopLoading]; [browser removeFromSuperview]; browser = nil; browserPolicy = nil; browserURL[0] = 0; }

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
        browserPolicy = [ORBrowserPolicy new];
        browser.navigationDelegate = browserPolicy;
        browser.UIDelegate = browserPolicy;
        browser.allowsBackForwardNavigationGestures = YES;
    }
    if (browser.superview != host) { [browser removeFromSuperview]; [host addSubview:browser]; }
    CGFloat top = host.isFlipped ? y : host.bounds.size.height - y - h;
    NSRect frame = NSMakeRect(x, top, w, h);
    if (!NSEqualRects(browser.frame, frame)) [browser setFrame:frame];
    if (url && url[0]) {
        NSURL *next = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
        if (next && ![next isEqual:browser.URL]) [browser loadRequest:[NSURLRequest requestWithURL:next]];
    }
    if (browser.hidden) [browser setHidden:NO];
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
