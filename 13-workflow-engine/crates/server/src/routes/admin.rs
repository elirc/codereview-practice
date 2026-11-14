use axum::response::Html;

const ADMIN_PAGE: &str = include_str!("../../static/admin.html");

/// `GET /`: the admin console. The page holds no data; it calls the API with a pasted token.
pub async fn index() -> Html<&'static str> {
    Html(ADMIN_PAGE)
}
