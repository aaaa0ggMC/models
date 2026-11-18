/**
 * src/url-token.test.ts —— 门户一键进入的一次性令牌读取/抹除（node 环境，无 DOM）。
 */

import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_PARAM, readAccessTokenFromSearch, urlWithoutAccessToken } from './url-token.js';

describe('readAccessTokenFromSearch', () => {
  it('读出令牌', () => {
    expect(readAccessTokenFromSearch(`?${ACCESS_TOKEN_PARAM}=abc123`)).toBe('abc123');
  });

  it('URL 编码的令牌原样解码', () => {
    expect(readAccessTokenFromSearch('?access_token=a%2Bb%2Fc%3D')).toBe('a+b/c=');
  });

  it('没有参数 / 空串 / 空值都算没有', () => {
    expect(readAccessTokenFromSearch('')).toBeNull();
    expect(readAccessTokenFromSearch('?')).toBeNull();
    expect(readAccessTokenFromSearch('?access_token=')).toBeNull();
    expect(readAccessTokenFromSearch('?other=1')).toBeNull();
  });

  it('别的参数在旁边时也只取令牌', () => {
    expect(readAccessTokenFromSearch('?from=portal&access_token=t&x=1')).toBe('t');
  });
});

describe('urlWithoutAccessToken', () => {
  it('抹掉令牌、保留 pathname 与 hash', () => {
    expect(urlWithoutAccessToken('/admin/', '#/usage', '?access_token=t')).toBe('/admin/#/usage');
  });

  it('查询串里还有别的参数时只删令牌', () => {
    expect(urlWithoutAccessToken('/admin/', '', '?from=portal&access_token=t')).toBe(
      '/admin/?from=portal',
    );
  });

  it('没有查询串时原样返回', () => {
    expect(urlWithoutAccessToken('/admin/', '#/chat', '')).toBe('/admin/#/chat');
    expect(urlWithoutAccessToken('/admin/', '', '?')).toBe('/admin/');
  });
});
