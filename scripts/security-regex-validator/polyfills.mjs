// Qt 6.11's JavaScript engine lacks Object.fromEntries, which regexpp uses for
// its fixed flag tables. Keep this compatibility shim separate from parsing.
if (!Object.fromEntries) {
	Object.fromEntries = function (entries) {
		const result = {};
		for (const [key, value] of entries) {
			Object.defineProperty(result, key, {
				value,
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return result;
	};
}
