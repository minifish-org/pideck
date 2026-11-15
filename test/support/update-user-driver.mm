#import <objc/runtime.h>
#include <cassert>
#include <cstdio>
#include <node_api.h>
// Exercise the production classes without registering a Node addon. Emit is
// inert without a Node callback; no networking, update UI or installation runs.
#undef NAPI_MODULE
#define NAPI_MODULE(modname, regfunc)
#include "../../native/updater.mm"

static void (^foundReply)(SPUUserUpdateChoice) = nil;
static int readyPrompts = 0;

static void Replace(SEL selector, id block) {
  method_setImplementation(class_getInstanceMethod(SPUStandardUserDriver.class, selector), imp_implementationWithBlock(block));
}

int main() {
  @autoreleasepool {
    (void)Initialize;
    Replace(@selector(showUpdateFoundWithAppcastItem:state:reply:), ^(id driver, SUAppcastItem *item,
        SPUUserUpdateState *state, void (^reply)(SPUUserUpdateChoice)) { foundReply = reply; });
    Replace(@selector(showReadyToInstallAndRelaunch:), ^(id driver, void (^reply)(SPUUserUpdateChoice)) { readyPrompts++; });
    Replace(@selector(dismissUpdateInstallation), ^(id driver) {});
    Replace(@selector(showUpdaterError:acknowledgement:), ^(id driver, NSError *error, void (^acknowledgement)(void)) { acknowledgement(); });
    Replace(@selector(showUpdateNotFoundWithError:acknowledgement:), ^(id driver, NSError *error, void (^acknowledgement)(void)) { acknowledgement(); });
    PideckUpdateUserDriver *driver = [[PideckUpdateUserDriver alloc] initWithHostBundle:NSBundle.mainBundle delegate:nil];
    SUAppcastItem *item = [SUAppcastItem emptyAppcastItem];
    // The superclass spies only capture replies, so no actual update state is
    // needed. The production subclass must forward this opaque value unchanged.
    SPUUserUpdateState *state = (SPUUserUpdateState *)[NSObject new];
    NSError *error = [NSError errorWithDomain:NSCocoaErrorDomain code:1 userInfo:nil];
    __block int installs = 0;
    void (^readyReply)(SPUUserUpdateChoice) = ^(SPUUserUpdateChoice choice) {
      assert(choice == SPUUserUpdateChoiceInstall);
      assert(!driver.installWhenReady);
      installs++;
    };
    auto choose = [&](SPUUserUpdateChoice choice) {
      __block BOOL forwarded = NO;
      [driver showUpdateFoundWithAppcastItem:item state:state reply:^(SPUUserUpdateChoice reply) {
        assert(reply == choice);
        assert(driver.installWhenReady == (choice == SPUUserUpdateChoiceInstall));
        forwarded = YES;
      }];
      void (^reply)(SPUUserUpdateChoice) = foundReply;
      foundReply = nil;
      reply(choice);
      assert(forwarded);
    };
    [driver showReadyToInstallAndRelaunch:readyReply];
    assert(readyPrompts == 1 && installs == 0);
    choose(SPUUserUpdateChoiceInstall);
    [driver showReadyToInstallAndRelaunch:readyReply];
    assert(readyPrompts == 1 && installs == 1);
    [driver showReadyToInstallAndRelaunch:readyReply];
    assert(readyPrompts == 2 && installs == 1);
    for (auto choice : {SPUUserUpdateChoiceSkip, SPUUserUpdateChoiceDismiss}) {
      choose(choice);
      [driver showReadyToInstallAndRelaunch:readyReply];
      assert(installs == 1);
    }
    choose(SPUUserUpdateChoiceInstall);
    [driver dismissUpdateInstallation];
    [driver showReadyToInstallAndRelaunch:readyReply];
    assert(readyPrompts == 5 && installs == 1);
    choose(SPUUserUpdateChoiceInstall);
    [driver showUpdaterError:error acknowledgement:^{}];
    [driver showReadyToInstallAndRelaunch:readyReply];
    assert(readyPrompts == 6 && installs == 1);
    choose(SPUUserUpdateChoiceInstall);
    [driver showUpdateNotFoundWithError:error acknowledgement:^{}];
    [driver showReadyToInstallAndRelaunch:readyReply];
    assert(readyPrompts == 7 && installs == 1);
    choose(SPUUserUpdateChoiceInstall);
    [driver showUpdateFoundWithAppcastItem:item state:state reply:^(SPUUserUpdateChoice choice) {}];
    [driver showReadyToInstallAndRelaunch:readyReply];
    assert(readyPrompts == 8 && installs == 1);
    foundReply = nil;
    puts("Native user-driver consent, automatic installation, and reset checks passed.");
  }
}
