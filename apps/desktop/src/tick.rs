//! Trackpad alignment haptic when the business wheel moves to another name.

/// A light alignment tap on a Force Touch trackpad. Call on the UI thread.
#[cfg(target_os = "macos")]
pub fn detent() {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    if rune::tooling::headless_run().is_some() {
        return;
    }
    unsafe {
        if let Some(haptics) = AnyClass::get(c"NSHapticFeedbackManager") {
            let performer: *mut AnyObject = msg_send![haptics, defaultPerformer];
            if let Some(performer) = performer.as_ref() {
                // NSHapticFeedbackPatternAlignment, NSHapticFeedbackPerformanceTimeNow.
                let _: () = msg_send![performer, performFeedbackPattern: 1isize, performanceTime: 1usize];
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn detent() {}