#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>
#include <node_api.h>

#include <memory>
#include <string>
#include <utility>

// This module is loaded only by Electron main. Sparkle owns update networking,
// signature verification, native UI, installation and relaunching.
struct UpdaterEvent {
  std::string type;
  std::string message;
  std::string domain;
  int64_t code = 0;
  bool canCheck = false;
};

static napi_threadsafe_function events = nullptr;
static SPUStandardUpdaterController *controller = nil;
static void *canCheckObservation = &canCheckObservation;

static void Emit(UpdaterEvent event) {
  if (events == nullptr) return;
  auto payload = std::make_unique<UpdaterEvent>(std::move(event));
  if (napi_call_threadsafe_function(events, payload.get(), napi_tsfn_nonblocking) == napi_ok) payload.release();
}

@interface PideckUpdaterDelegate : NSObject <SPUUpdaterDelegate>
@property(nonatomic, copy) void (^pendingInstall)(void);
@property(nonatomic) BOOL observing;
@end

static PideckUpdaterDelegate *updaterDelegate = nil;

static bool CanCheck() {
  return controller != nil && updaterDelegate.pendingInstall == nil && controller.updater.canCheckForUpdates;
}

@implementation PideckUpdaterDelegate
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater {
  // Sparkle also supports a historical user-default feed override. This app
  // always uses the verified URL in its signed application bundle instead.
  return NSBundle.mainBundle.infoDictionary[@"SUFeedURL"];
}

- (BOOL)updater:(SPUUpdater *)updater
    shouldPostponeRelaunchForUpdate:(SUAppcastItem *)item
    untilInvokingBlock:(void (^)(void))installHandler {
  // Electron main asks its existing quit guard, then closes the trusted host
  // before resuming this one-shot native installation. No shell replacement.
  self.pendingInstall = installHandler;
  Emit({.type = "can-check-changed", .canCheck = false});
  Emit({.type = "install-requested"});
  return YES;
}

- (void)updater:(SPUUpdater *)updater didAbortWithError:(NSError *)error {
  self.pendingInstall = nil;
  Emit({.type = "aborted", .message = error.localizedDescription.UTF8String ?: "Update check failed.",
    .domain = error.domain.UTF8String ?: "", .code = error.code});
  Emit({.type = "can-check-changed", .canCheck = CanCheck()});
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object
    change:(NSDictionary<NSKeyValueChangeKey, id> *)change context:(void *)context {
  if (context == canCheckObservation) {
    Emit({.type = "can-check-changed", .canCheck = CanCheck()});
  } else {
    [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
  }
}
@end

static napi_value Undefined(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value BooleanValue(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

static bool MainThread(napi_env env) {
  if ([NSThread isMainThread]) return true;
  napi_throw_error(env, nullptr, "The native updater may only be used by Electron main.");
  return false;
}

static void SetString(napi_env env, napi_value object, const char *name, const std::string &value) {
  napi_value string;
  if (napi_create_string_utf8(env, value.data(), value.size(), &string) == napi_ok) {
    napi_set_named_property(env, object, name, string);
  }
}

static void CallJS(napi_env env, napi_value callback, void *context, void *data) {
  std::unique_ptr<UpdaterEvent> event(static_cast<UpdaterEvent *>(data));
  // Aborting a TSFN at environment teardown still calls this to free its data.
  if (env == nullptr || callback == nullptr) return;
  napi_value object;
  if (napi_create_object(env, &object) != napi_ok) return;
  SetString(env, object, "type", event->type);
  if (event->type == "can-check-changed") {
    napi_set_named_property(env, object, "canCheck", BooleanValue(env, event->canCheck));
  } else if (event->type == "aborted") {
    SetString(env, object, "message", event->message);
    SetString(env, object, "domain", event->domain);
    napi_value code;
    if (napi_create_int64(env, event->code, &code) == napi_ok) napi_set_named_property(env, object, "code", code);
  }
  napi_value result;
  if (napi_call_function(env, Undefined(env), callback, 1, &object, &result) == napi_pending_exception) {
    napi_value exception;
    if (napi_get_and_clear_last_exception(env, &exception) == napi_ok) napi_fatal_exception(env, exception);
  }
}

static void DisposeBridge() {
  if (updaterDelegate.observing) {
    [controller.updater removeObserver:updaterDelegate forKeyPath:@"canCheckForUpdates" context:canCheckObservation];
    updaterDelegate.observing = NO;
  }
  updaterDelegate.pendingInstall = nil;
  controller = nil;
  updaterDelegate = nil;
  if (events != nullptr) {
    napi_release_threadsafe_function(events, napi_tsfn_abort);
    events = nullptr;
  }
}

static void Cleanup(void *) {
  // Registration and all use are main-only; Electron tears down this Node
  // environment on its main thread as well.
  @autoreleasepool { DisposeBridge(); }
}

static bool ValidConfiguration(napi_env env) {
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  id feedValue = info[@"SUFeedURL"];
  NSURL *feed = [feedValue isKindOfClass:NSString.class] ? [NSURL URLWithString:feedValue] : nil;
  BOOL https = [feed.scheme.lowercaseString isEqualToString:@"https"];
  // A literal loopback feed allows isolated packaged acceptance with an
  // ephemeral signing key. Production packaging requires HTTPS. No override is
  // accepted from JavaScript, the environment, or the renderer.
  BOOL loopback = [feed.host isEqualToString:@"127.0.0.1"] || [feed.host isEqualToString:@"::1"]
    || [feed.host isEqualToString:@"[::1]"];
  BOOL localHTTP = [feed.scheme.lowercaseString isEqualToString:@"http"] && loopback;
  id publicKey = info[@"SUPublicEDKey"];
  NSData *key = [publicKey isKindOfClass:NSString.class]
    ? [[NSData alloc] initWithBase64EncodedString:publicKey options:0] : nil;
  if (feed.host.length == 0 || feed.user != nil || feed.password != nil || !(https || localHTTP)
      || key.length != 32 || ![info[@"SUVerifyUpdateBeforeExtraction"] boolValue]
      || ![info[@"SURequireSignedFeed"] boolValue]
      || info[@"SUSignedFeedFailureExpirationInterval"] == nil
      || [info[@"SUSignedFeedFailureExpirationInterval"] doubleValue] != 0) {
    napi_throw_error(env, nullptr, "The packaged updater requires a trusted feed and fail-closed Ed25519 signature verification.");
    return false;
  }
  return true;
}

static napi_value Start(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  @autoreleasepool {
    if (controller != nil || events != nullptr) {
      napi_throw_error(env, nullptr, "The native updater has already started.");
      return nullptr;
    }
    size_t argc = 1;
    napi_value callback;
    napi_valuetype type;
    if (napi_get_cb_info(env, info, &argc, &callback, nullptr, nullptr) != napi_ok || argc != 1
        || napi_typeof(env, callback, &type) != napi_ok || type != napi_function) {
      napi_throw_type_error(env, nullptr, "The native updater requires an event callback.");
      return nullptr;
    }
    if (!ValidConfiguration(env)) return nullptr;
    napi_value resourceName;
    napi_create_string_utf8(env, "Pideck native updater", NAPI_AUTO_LENGTH, &resourceName);
    if (napi_create_threadsafe_function(env, callback, nullptr, resourceName, 0, 1,
        nullptr, nullptr, nullptr, CallJS, &events) != napi_ok) {
      events = nullptr;
      napi_throw_error(env, nullptr, "Could not initialize native updater events.");
      return nullptr;
    }
    napi_unref_threadsafe_function(env, events);
    updaterDelegate = [[PideckUpdaterDelegate alloc] init];
    controller = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:NO
      updaterDelegate:updaterDelegate userDriverDelegate:nil];
    [controller.updater addObserver:updaterDelegate forKeyPath:@"canCheckForUpdates"
      options:NSKeyValueObservingOptionNew context:canCheckObservation];
    updaterDelegate.observing = YES;
    NSError *error = nil;
    if (![controller.updater startUpdater:&error]) {
      std::string message = error.localizedDescription.UTF8String ?: "Could not start the native updater.";
      DisposeBridge();
      napi_throw_error(env, nullptr, message.c_str());
      return nullptr;
    }
    return BooleanValue(env, CanCheck());
  }
}

static napi_value Check(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  @autoreleasepool {
    if (!CanCheck()) return BooleanValue(env, false);
    [controller checkForUpdates:nil];
    return BooleanValue(env, true);
  }
}

static napi_value ResumeInstall(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  @autoreleasepool {
    void (^handler)(void) = updaterDelegate.pendingInstall;
    if (handler == nil) return BooleanValue(env, false);
    updaterDelegate.pendingInstall = nil;
    handler();
    return BooleanValue(env, true);
  }
}

static napi_value CanCheckValue(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  return BooleanValue(env, CanCheck());
}

static napi_value Dispose(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  @autoreleasepool { DisposeBridge(); }
  return Undefined(env);
}

static napi_value Initialize(napi_env env, napi_value exports) {
  if (!MainThread(env)) return nullptr;
  const napi_property_descriptor methods[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"check", nullptr, Check, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"resumeInstall", nullptr, ResumeInstall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"canCheck", nullptr, CanCheckValue, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"dispose", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok
      || napi_add_env_cleanup_hook(env, Cleanup, nullptr) != napi_ok) return nullptr;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
