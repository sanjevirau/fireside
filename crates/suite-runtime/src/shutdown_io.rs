//! End long-lived Firestore connections when the suite has finished draining.
//! Stopping the accept loop alone leaves WebChannel/gRPC responses open forever.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::Stream as _;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_stream::wrappers::WatchStream;
use tonic::transport::server::{Connected, TcpConnectInfo};

pub(super) struct ShutdownIo {
    socket: TcpStream,
    shutdown: WatchStream<bool>,
    closed: bool,
}

impl ShutdownIo {
    pub(super) fn new(socket: TcpStream, shutdown: watch::Receiver<bool>) -> Self {
        Self {
            socket,
            shutdown: WatchStream::new(shutdown),
            closed: false,
        }
    }

    fn check_shutdown(&mut self, context: &mut Context<'_>) -> io::Result<()> {
        // Poll the signal even while the underlying socket is idle, so a held
        // response cannot prevent server shutdown. Latch closure across polls.
        while !self.closed {
            match Pin::new(&mut self.shutdown).poll_next(context) {
                Poll::Ready(Some(false)) => {}
                Poll::Ready(Some(true) | None) => self.closed = true,
                Poll::Pending => break,
            }
        }
        if self.closed {
            Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "Fireside suite is shutting down",
            ))
        } else {
            Ok(())
        }
    }
}

impl Connected for ShutdownIo {
    type ConnectInfo = TcpConnectInfo;
    fn connect_info(&self) -> Self::ConnectInfo {
        self.socket.connect_info()
    }
}

impl AsyncRead for ShutdownIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.check_shutdown(context)?;
        Pin::new(&mut self.socket).poll_read(context, buffer)
    }
}

impl AsyncWrite for ShutdownIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.check_shutdown(context)?;
        Pin::new(&mut self.socket).poll_write(context, buffer)
    }
    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check_shutdown(context)?;
        Pin::new(&mut self.socket).poll_flush(context)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(context)
    }
    fn is_write_vectored(&self) -> bool {
        self.socket.is_write_vectored()
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        self.check_shutdown(context)?;
        Pin::new(&mut self.socket).poll_write_vectored(context, buffers)
    }
}
