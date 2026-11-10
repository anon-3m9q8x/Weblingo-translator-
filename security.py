"""Guardrails for fetching user-provided public web pages.

The server resolves DNS once, validates every answer and then connects to the
validated IP directly (TLS still verifies the original hostname), which blocks
DNS-rebinding tricks. An egress firewall is still recommended for defence in depth.
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit


class UnsafeURL(ValueError):
    pass


def is_public_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return addr.is_global


def parse_public_url(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        raise UnsafeURL("URLを入力してください。")
    if len(raw) > 2048:
        raise UnsafeURL("URLが長すぎます。")
    if '://' not in raw:
        raw = 'https://' + raw
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        raise UnsafeURL("URLの形式が正しくありません。") from None
    if parts.scheme not in ('https', 'http') or not parts.hostname:
        raise UnsafeURL("http / https の公開URLのみ指定できます。")
    if parts.username or parts.password:
        raise UnsafeURL("認証情報を含むURLは指定できません。")
    if port is not None and port not in (80, 443):
        raise UnsafeURL("安全のため、80 / 443以外のポートは指定できません。")
    host = parts.hostname.lower().rstrip('.')
    if host in ('localhost', 'localhost.localdomain') or host.endswith(('.local', '.internal', '.localhost')):
        raise UnsafeURL("ローカルネットワークのURLは取得できません。")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if not ip.is_global:
            raise UnsafeURL("プライベートIPアドレスは指定できません。")
    return raw


def assert_public_dns(url: str) -> str:
    """Resolve the host, reject non-public answers and return one validated IP to connect to."""
    parts = urlsplit(url)
    hostname = parts.hostname
    if not hostname:
        raise UnsafeURL("ホストが見つかりません。")
    try:
        answers = socket.getaddrinfo(hostname, parts.port or (443 if parts.scheme == 'https' else 80), type=socket.SOCK_STREAM)
    except OSError as exc:
        raise UnsafeURL("指定されたホストの名前を解決できません。") from exc
    addrs = {entry[4][0] for entry in answers}
    if not addrs or any(not is_public_ip(addr) for addr in addrs):
        raise UnsafeURL("公開インターネット上のWebサイトのみ取得できます。")
    return sorted(addrs, key=lambda a: ':' in a)[0]  # prefer IPv4


def pinned_request_url(url: str, ip: str) -> tuple[str, str]:
    """Rewrite URL so the connection goes to the already-validated IP (DNS rebinding defence).

    Returns (url_with_ip, original_host_header)."""
    parts = urlsplit(url)
    host_ip = f'[{ip}]' if ':' in ip else ip
    netloc = host_ip + (f':{parts.port}' if parts.port else '')
    host_header = parts.hostname + (f':{parts.port}' if parts.port else '')
    return parts._replace(netloc=netloc).geturl(), host_header
