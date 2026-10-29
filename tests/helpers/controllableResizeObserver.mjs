/**
 * 可控 ResizeObserver 测试替身：
 * 满足计划步骤 0.3 要求：
 * 1. 记录被观察节点；
 * 2. 模拟 observe() 后的初次通知；
 * 3. 支持同批次投递不同目标（viewport / list / row）；
 * 4. 支持投递不同宽度、不同高度或重复相同尺寸；
 * 5. 在 disconnect 后阻断后续通知。
 */
export class ControllableResizeObserver {
	static instances = [];

	constructor(callback) {
		this.callback = callback;
		this.observed = new Set();
		this.disconnected = false;
		ControllableResizeObserver.instances.push(this);
	}

	observe(target) {
		if (this.disconnected) return;
		this.observed.add(target);
	}

	unobserve(target) {
		this.observed.delete(target);
	}

	disconnect() {
		this.disconnected = true;
		this.observed.clear();
	}

	/** 投递指定的一组 entries */
	dispatchEntries(entries) {
		if (this.disconnected) return;
		const validEntries = entries.filter((e) => this.observed.has(e.target));
		if (validEntries.length > 0) {
			this.callback(validEntries, this);
		}
	}

	/** 强制投递已排队通知（模拟 disconnect 前已进入事件循环、在 disconnect 后才回调到达的迟到通知） */
	dispatchLateEntries(entries) {
		if (entries.length > 0) {
			this.callback(entries, this);
		}
	}

	/** 辅助 helper：为指定元素构造 entry */
	static createEntry(target, { width = 100, height = 100 } = {}) {
		return {
			target,
			contentRect: {
				width,
				height,
				top: 0,
				left: 0,
				bottom: height,
				right: width,
			},
			borderBoxSize: [
				{
					inlineSize: width,
					blockSize: height,
				},
			],
		};
	}

	static reset() {
		ControllableResizeObserver.instances = [];
	}
}
