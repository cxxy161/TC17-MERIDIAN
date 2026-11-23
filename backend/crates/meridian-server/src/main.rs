fn main() {
    println!(
        "Meridian server skeleton ready (core v{}, sandbox v{})",
        meridian_core::engine_version(),
        meridian_sandbox::sandbox_ready(),
    );
}
