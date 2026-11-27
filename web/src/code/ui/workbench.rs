// The workbench emits keyed regions. The web adapter reconciles them with
// existing DOM nodes so opening a panel preserves the editor, selection and IME.
#![no_std]
use core::panic::PanicInfo;
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[link(wasm_import_module = "layout")]
extern "C" {
    fn begin(tag: *const u8, tag_len: usize, class: *const u8, class_len: usize);
    fn end();
    fn control(
        id: *const u8,
        id_len: usize,
        label: *const u8,
        label_len: usize,
        class: *const u8,
        class_len: usize,
    );
    fn region(name: *const u8, len: usize);
}

fn group(tag: &str, class: &str, children: impl FnOnce()) {
    unsafe {
        begin(tag.as_ptr(), tag.len(), class.as_ptr(), class.len());
    }
    children();
    unsafe {
        end();
    }
}
fn slot(name: &str) {
    unsafe {
        region(name.as_ptr(), name.len());
    }
}

fn button(id: &str, label: &str, class: &str) {
    unsafe {
        control(
            id.as_ptr(),
            id.len(),
            label.as_ptr(),
            label.len(),
            class.as_ptr(),
            class.len(),
        );
    }
}

// The workbench looks like Fleet: tool islands on a recessed shell, with the
// workspace switcher and panel toggles on the left and Go to in the middle.
#[no_mangle]
pub extern "C" fn render_project(tree: bool, tools: bool, panel: bool, terminal: bool) {
    group("header", "code-toolbar", || {
        button("project", "Projects", "code-switcher");
        group("div", "code-toggles", || {
            button("tree", "Files Panel", "code-icon code-toggle");
            button("panel", "Bottom Panel", "code-icon code-toggle");
            button("tools", "Structure", "code-icon code-toggle");
        });
        group("div", "code-toolbar-fill", || {});
        button("search", "Quick Open", "code-goto");
        group("div", "code-toolbar-fill", || {});
        // Linux and SSH projects have a shell; it opens in the bottom panel.
        if terminal {
            button("terminal", "Terminal", "code-icon code-toggle");
        }
        button("actions", "Actions", "code-icon");
    });
    group(
        "div",
        if tree {
            "code-work-area tree-open"
        } else {
            "code-work-area"
        },
        || {
            if tree {
                slot("explorer");
                slot("explorerDivider");
            }
            group("div", "code-center", || {
                slot("editor");
                if panel {
                    slot("panelDivider");
                }
                // Keep the PTY session mounted while its tool panel is hidden.
                slot("bottom");
            });
            if tools {
                slot("toolsDivider");
                slot("structure");
            }
        },
    );
    slot("status");
    slot("children");
}

#[no_mangle]
pub extern "C" fn render_file() {
    group("div", "code-work-area", || {
        group("section", "code-editor-area island", || {
            group("header", "code-file-bar", || {
                button("project", "Projects", "code-icon");
                slot("tab");
                slot("actions");
            });
            slot("alerts");
            slot("source");
        });
    });
    slot("status");
    slot("children");
}
