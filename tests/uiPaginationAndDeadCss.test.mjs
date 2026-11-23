import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mountReact } from "./helpers/mountReact.mjs";

function loadPagination(React, inputHandlers) {
	return loadTsCommonJs("src/renderer/src/components/ui-shadcn/pagination.tsx", {
		stubs: {
			"../../i18n": { t: (key, params) => (params?.page ? `${key}:${params.page}` : key) },
			"@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
			"lucide-react": {
				ChevronLeft: () => null,
				ChevronRight: () => null,
			},
			"./input": {
				Input: (props) => {
					if (inputHandlers) inputHandlers.current = props;
					return React.createElement("input", {
						"aria-label": props["aria-label"],
						value: props.value ?? "",
						onChange: props.onChange,
						onKeyDown: props.onKeyDown,
						onBlur: props.onBlur,
					});
				},
			},
		},
	});
}

function pageLabels(document) {
	return [...document.querySelectorAll("button[aria-label^='pagination.page']")]
		.map((button) => button.textContent);
}

test("Pagination renders the page window and moves with previous and next", async () => {
	const pages = [];
	await mountReact(async ({ React, act, root, document, click }) => {
		const { Pagination } = loadPagination(React);
		const renderAt = async (page) => {
			await act(() => {
				root.render(React.createElement(Pagination, {
					page,
					totalPages: 20,
					onPageChange: (next) => pages.push(next),
				}));
			});
		};
		await renderAt(10);
		assert.deepEqual(pageLabels(document), ["1", "8", "9", "10", "11", "12", "20"]);
		assert.equal(document.querySelector("[aria-current='page']").textContent, "10");
		assert.deepEqual(
			[...document.querySelectorAll("span")].map((node) => node.textContent).filter((text) => text === "…"),
			["…", "…"],
		);

		await click(document.querySelector("button[aria-label='pagination.previous']"));
		await click(document.querySelector("button[aria-label='pagination.next']"));
		assert.deepEqual(pages, [9, 11]);

		await renderAt(1);
		assert.equal(document.querySelector("button[aria-label='pagination.previous']").disabled, true);
		assert.ok(document.querySelector("input[aria-label='pagination.jumpTo']"));
		await renderAt(20);
		assert.equal(document.querySelector("button[aria-label='pagination.next']").disabled, true);
	});
});

test("Pagination jump uses the typed value, ignores invalid input, and clears the field", async () => {
	const pages = [];
	const inputHandlers = { current: null };
	await mountReact(async ({ React, act, root }) => {
		const { Pagination } = loadPagination(React, inputHandlers);
		const renderAt = async (page) => {
			await act(() => {
				root.render(React.createElement(Pagination, {
					page,
					totalPages: 5,
					onPageChange: (next) => pages.push(next),
				}));
			});
		};
		const type = async (value) => {
			await act(() => {
				inputHandlers.current.onChange({ target: { value } });
			});
		};
		const pressEnter = async () => {
			await act(() => {
				inputHandlers.current.onKeyDown({ key: "Enter" });
			});
		};

		await renderAt(2);
		await type("4");
		assert.equal(inputHandlers.current.value, "4");
		await pressEnter();
		assert.deepEqual(pages, [4]);
		assert.equal(inputHandlers.current.value, "");

		await type("9");
		await pressEnter();
		await type("4.5");
		await pressEnter();
		await type("2");
		await pressEnter();
		assert.deepEqual(pages, [4]);
		assert.equal(inputHandlers.current.value, "");

		await type("3");
		await act(() => {
			inputHandlers.current.onBlur();
		});
		assert.equal(inputHandlers.current.value, "");
		assert.deepEqual(pages, [4]);
	});
});
