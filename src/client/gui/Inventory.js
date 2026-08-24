export class Inventory {
    constructor(locationName, listName, width, height) {
        this.locationName = locationName;
        this.listName = listName;
        this.width = Math.max(1, Math.floor(width || 1));
        this.height = Math.max(1, Math.floor(height || 1));
        this.size = this.width * this.height;
        this.slots = new Array(this.size).fill(null);
        this.attachedFormspecs = new Set();
        this.onRenderItemCallback = null;
        this.activeSlotIndex = 0;
        this._updateAttachedVisuals = this._updateAttachedVisuals.bind(this);
        this._moveFloatingCursorItem = this._moveFloatingCursorItem.bind(this);
    }

    registerItemRenderer(callback) {
        if (typeof callback === 'function') {
            this.onRenderItemCallback = callback;
            this.refreshAttachedViews();
        }
    }

    setItem(slotId, item) {
        if (slotId >= 0 && slotId < this.size) {
            this.slots[slotId] = item;
            this.refreshAttachedViews();
        }
    }

    getItem(slotId) {
        if (slotId >= 0 && slotId < this.size) {
            return this.slots[slotId];
        }
        return null;
    }

    setActiveSlot(slotId) {
        if (slotId >= 0 && slotId < 8) {
            this.activeSlotIndex = slotId;
            this.refreshAttachedViews();
        }
    }

    attachFormspec(formspecInstance) {
        if (!formspecInstance) return;
        this.attachedFormspecs.add(formspecInstance);
        this.refreshAttachedViews();
    }

    detachFormspec(formspecInstance) {
        if (!formspecInstance) return;
        this.attachedFormspecs.delete(formspecInstance);
    }

    refreshAttachedViews() {
        this.attachedFormspecs.forEach((formspec) => {
            if (formspec && typeof formspec._injectInventoryBridge === 'function') {
                formspec._injectInventoryBridge();
            }
            this._updateAttachedVisuals(formspec);
        });
    }

    _updateAttachedVisuals(formspec) {
        if (!formspec || !formspec.containerElement) return;

        const isHud = formspec.containerElement.classList.contains('is-hud');
        if (isHud) {
            formspec.containerElement.style.display = 'flex';
            formspec.containerElement.style.justifyContent = 'center';
            formspec.containerElement.style.alignItems = 'flex-end';
            formspec.containerElement.style.paddingBottom = '20px';
            formspec.containerElement.style.pointerEvents = 'none';
            formspec.containerElement.style.position = 'fixed';
            formspec.containerElement.style.top = '0';
            formspec.containerElement.style.left = '0';
            formspec.containerElement.style.width = '100vw';
            formspec.containerElement.style.height = '100vh';
            formspec.containerElement.style.zIndex = '1000';

            const innerPanel = formspec.containerElement.querySelector('.formspec_ast-base > div');
            if (innerPanel) {
                innerPanel.style.position = 'relative';
                innerPanel.style.top = 'auto';
                innerPanel.style.left = 'auto';
                innerPanel.style.margin = '0 auto';
                innerPanel.style.background = 'transparent';
                innerPanel.style.border = 'none';
            }
        }

        const listContainers = formspec.containerElement.querySelectorAll('.formspec_ast-list[data-type="list"]');

        listContainers.forEach((container) => {
            const rawDataAttr = container.getAttribute('data-formspec_ast');
            if (!rawDataAttr) return;

            let config;
            try {
                config = JSON.parse(rawDataAttr);
            } catch (e) {
                return;
            }

            if (config.inventory_location !== this.locationName || config.list_name !== this.listName) {
                return;
            }

            if (isHud) {
                container.style.pointerEvents = 'auto';
            }

            const startIdx = parseInt(config.starting_item_index || 0, 10);
            const cols = parseInt(config.w || this.width, 10);
            const rows = parseInt(config.h || this.height, 10);
            const totalCellsToFill = cols * rows;

            const table = container.querySelector('table');
            if (!table) return;

            const assetPath = formspec.assetPath || '';
            const allCells = table.querySelectorAll('td');

            for (let i = 0; i < totalCellsToFill; i++) {
                const cell = allCells[i];
                if (!cell) continue;

                const slotId = startIdx + i;
                cell.innerHTML = '';
                cell.style.outline = 'none';
                cell.style.outlineOffset = '0px';

                if (isHud) {
                    cell.style.pointerEvents = 'auto';
                }

                if (!cell.hasAttribute('data-slot-bound')) {
                    cell.setAttribute('data-slot-bound', 'true');
                    cell.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this._handleSlotClick(slotId);
                    });
                }

                if (slotId >= this.size) continue;

                const currentItem = this.slots[slotId];
                if (!currentItem) continue;

                let itemTexture = '';
                if (this.onRenderItemCallback) {
                    itemTexture = this.onRenderItemCallback(currentItem, slotId);
                } else if (typeof currentItem === 'string') {
                    itemTexture = currentItem;
                } else if (currentItem && currentItem.texture) {
                    itemTexture = currentItem.texture;
                }

                if (itemTexture) {
                    const img = document.createElement('img');
                    if (itemTexture.startsWith('data:')) {
                        img.src = itemTexture.replaceAll('^', ';');
                    } else {
                        let finalSrc = itemTexture;
                        if (!finalSrc.startsWith('resources/')) {
                            finalSrc = `resources/texture/block/${finalSrc}`;
                        }
                        img.src = `${assetPath}${finalSrc}`;
                    }

                    img.style.width = '100%';
                    img.style.height = '100%';
                    img.style.maxWidth = '100%';
                    img.style.maxHeight = '100%';
                    img.style.objectFit = 'contain';
                    img.style.imageRendering = 'pixelated';
                    img.style.display = 'block';
                    img.style.pointerEvents = 'none';
                    img.alt = `Slot ${slotId}`;
                    cell.appendChild(img);
                }

                if (slotId === this.activeSlotIndex) {
                    cell.style.outline = '3px solid #ffaa00';
                    cell.style.outlineOffset = '-3px';
                }
            }
        });

        this._renderFloatingCursorItem();
    }

    _handleSlotClick(slotId) {
        const heldItem = window.cursorHeldItem || null;
        const targetItem = this.slots[slotId];

        if (!heldItem && !targetItem) return;

        if (!heldItem && targetItem) {
            window.cursorHeldItem = targetItem;
            this.slots[slotId] = null;
        } else if (heldItem && !targetItem) {
            this.slots[slotId] = heldItem;
            window.cursorHeldItem = null;
        } else if (heldItem && targetItem) {
            this.slots[slotId] = heldItem;
            window.cursorHeldItem = targetItem;
        }

        const globalInventories = window.globalInventories || {};
        Object.values(globalInventories).forEach(inv => {
            if (inv && typeof inv.refreshAttachedViews === 'function') {
                inv.refreshAttachedViews();
            }
        });
    }

    _renderFloatingCursorItem() {
        let floatImg = document.getElementById('inventory-cursor-floating-item');
        const heldItem = window.cursorHeldItem || null;

        if (!heldItem) {
            if (floatImg) floatImg.remove();
            document.removeEventListener('mousemove', this._moveFloatingCursorItem);
            return;
        }

        if (!floatImg) {
            floatImg = document.createElement('img');
            floatImg.id = 'inventory-cursor-floating-item';
            floatImg.style.position = 'fixed';
            floatImg.style.width = '40px';
            floatImg.style.height = '40px';
            floatImg.style.pointerEvents = 'none';
            floatImg.style.zIndex = '99999';
            floatImg.style.imageRendering = 'pixelated';
            document.body.appendChild(floatImg);
            document.addEventListener('mousemove', this._moveFloatingCursorItem);
        }

        let itemTexture = typeof heldItem === 'string' ? heldItem : heldItem.texture;
        if (itemTexture) {
            if (itemTexture.startsWith('data:')) {
                floatImg.src = itemTexture.replaceAll('^', ';');
            } else {
                if (!itemTexture.startsWith('resources/')) {
                    itemTexture = `resources/texture/block/${itemTexture}`;
                }
                floatImg.src = itemTexture;
            }
        }
    }

    _moveFloatingCursorItem(e) {
        const floatImg = document.getElementById('inventory-cursor-floating-item');
        if (floatImg) {
            floatImg.style.left = `${e.clientX - 20}px`;
            floatImg.style.top = `${e.clientY - 20}px`;
        }
    }
}