import queryString from "query-string";

// Namespace compatibility for React Navigation 7 with query-string 9.
export const { parse, stringify, extract, parseUrl, stringifyUrl, pick, exclude } = queryString;
export default queryString;
