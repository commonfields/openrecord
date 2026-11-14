#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

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

void or_preview_hide(void) { [preview setHidden:YES]; }
void or_preview_clear(void) { [preview stopLoading]; [preview removeFromSuperview]; preview = nil; policy = nil; document = nil; }

void or_preview_show(const char *html, double x, double y, double w, double h) {
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
        policy = [ORPreviewPolicy new];
        preview.navigationDelegate = policy;
        preview.allowsBackForwardNavigationGestures = NO;
    }
    if (preview.superview != host) { [preview removeFromSuperview]; [host addSubview:preview]; }
    CGFloat top = host.isFlipped ? y : host.bounds.size.height - y - h;
    [preview setFrame:NSMakeRect(x, top, w, h)];
    [preview setHidden:NO];
    NSString *next = [NSString stringWithUTF8String:html];
    if (![next isEqualToString:document]) {
        document = next;
        [preview loadHTMLString:next baseURL:nil];
    }
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
