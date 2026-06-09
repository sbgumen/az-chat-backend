const IP2Region = require('ip2region').default;

const query = new IP2Region();

/**
 * 查询 IP 归属地
 * @param {string} ip - 要查询的 IP 地址
 * @returns {string} 格式化后的地址字符串，如 "南宁 · 广西" 或 "中国 · 广西"
 */
function ipToLocation(ip) {
  try {
    const res = query.search(ip);
    if (!res) return '';
    const { country, province, city, isp } = res;
    const parts = [];
    if (country && country !== '中国') parts.push(country);
    if (province && !city) parts.push(province);
    if (city && province && city !== province) {
      parts.push(city);
      parts.push(province);
    } else if (city) {
      parts.push(city);
    } else if (province) {
      parts.push(province);
    } else if (country) {
      parts.push(country);
    }
    return parts.join(' · ');
  } catch {
    return '';
  }
}

module.exports = { ipToLocation };
