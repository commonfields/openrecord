//! Dates as the web app words them (`lib/format.ts`).

use std::time::{SystemTime, UNIX_EPOCH};

/// Seconds since the epoch for an ISO 8601 UTC timestamp such as
/// `2026-11-06T15:48:41.484Z`, without a date library.
pub fn parse_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (h, mi, se) = (n(11..13)?, n(14..16)?, n(17..19)?);
    // Days from civil (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + h * 3600 + mi * 60 + se)
}

/// "2026-11-10" for seconds since the epoch (civil from days, Howard Hinnant's algorithm).
pub fn iso_date(t: i64) -> String {
    let z = t.div_euclid(86400) + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

/// "Nov 6" for a "2026-11-06" day, for chart axes.
pub fn short_day(iso: &str) -> String {
    let (Some(m), Some(d)) = (iso.get(5..7).and_then(|m| m.parse::<usize>().ok()), iso.get(8..10).and_then(|d| d.parse::<u32>().ok())) else {
        return iso.to_string();
    };
    format!("{} {d}", MONTHS.get(m.wrapping_sub(1)).copied().unwrap_or("?"))
}

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "Nov 6, 2026".
pub fn date(iso: &str) -> String {
    let (Some(y), Some(m), Some(d)) = (iso.get(0..4), iso.get(5..7).and_then(|m| m.parse::<usize>().ok()), iso.get(8..10).and_then(|d| d.parse::<u32>().ok())) else {
        return "Unknown".into();
    };
    format!("{} {d}, {y}", MONTHS.get(m.wrapping_sub(1)).copied().unwrap_or("?"))
}

/// "5 minutes ago", "yesterday", "in 2 hours", then a date past 30 days.
pub fn relative(iso: Option<&str>, now: i64) -> String {
    let Some(iso) = iso else { return "Never".into() };
    let Some(then) = parse_iso(iso) else { return "Unknown".into() };
    let seconds = then - now;
    let abs = seconds.abs();
    let (value, unit) = if abs < 60 {
        return if abs < 10 { "now".into() } else { phrase(seconds, "second") };
    } else if abs < 3600 {
        ((seconds as f64 / 60.0).round() as i64, "minute")
    } else if abs < 86400 {
        ((seconds as f64 / 3600.0).round() as i64, "hour")
    } else if abs < 86400 * 30 {
        ((seconds as f64 / 86400.0).round() as i64, "day")
    } else {
        return date(iso);
    };
    if unit == "day" && value == -1 {
        return "yesterday".into();
    }
    if unit == "day" && value == 1 {
        return "tomorrow".into();
    }
    phrase(value, unit)
}

fn phrase(value: i64, unit: &str) -> String {
    let n = value.abs();
    let unit = if n == 1 { unit.to_string() } else { format!("{unit}s") };
    if value < 0 { format!("{n} {unit} ago") } else { format!("in {n} {unit}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_utc_timestamps() {
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso("2026-11-06T15:48:41.484Z"), Some(1_793_980_121));
    }

    #[test]
    fn words_distances_like_the_web() {
        let now = parse_iso("2026-11-10T12:00:00Z").unwrap();
        assert_eq!(relative(Some("2026-11-10T11:55:00Z"), now), "5 minutes ago");
        assert_eq!(relative(Some("2026-11-09T12:00:00Z"), now), "yesterday");
        assert_eq!(relative(Some("2026-11-06T12:00:00Z"), now), "4 days ago");
        assert_eq!(relative(Some("2026-09-01T12:00:00Z"), now), "Sep 1, 2026");
        assert_eq!(relative(None, now), "Never");
    }
}
