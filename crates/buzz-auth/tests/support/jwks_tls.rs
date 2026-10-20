use std::sync::Arc;
use tokio_rustls::{rustls, TlsAcceptor};

pub struct TlsFixture {
    pub acceptor: TlsAcceptor,
    pub root_der: Vec<u8>,
}

impl TlsFixture {
    pub fn new() -> Self {
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let der = cert.cert.der().clone();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![der.clone()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()).into(),
        )
        .unwrap();
        Self {
            acceptor: TlsAcceptor::from(Arc::new(config)),
            root_der: der.to_vec(),
        }
    }

    pub async fn accept(
        &self,
        listener: &tokio::net::TcpListener,
    ) -> tokio_rustls::server::TlsStream<tokio::net::TcpStream> {
        let (stream, _) = listener.accept().await.expect("accept HTTPS connection");
        self.acceptor.accept(stream).await.expect("TLS handshake")
    }
}
