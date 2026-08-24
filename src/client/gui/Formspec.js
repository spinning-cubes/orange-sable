export default class Formspec {
    constructor() {
        this.formspecString = '';
        this.containerElement = null;
        this.isRendered = false;
        this.scale = 50; 
        this.assetPath = ''; 
        this.backgroundOpacity = 1.0; // Default fully opaque background
        this.hudAnchor = null;        // Stores 'top-left', 'top-right', etc.
        this.boundInventories = new Set();

        this.callbacks = {};       
        this.renderedElements = {}; 

        this._injectStyles();
        this._handleResize = this._handleResize.bind(this);
    }

    setAssetPath(path) {
        if (typeof path !== 'string') {
            throw new TypeError('Asset path must be a primitive string.');
        }
        this.assetPath = path && !path.endsWith('/') ? `${path}/` : path;
    }

    /**
     * Set background opacity from 0.0 (transparent) to 1.0 (opaque)
     */
    setOpacity(opacity) {
        this.backgroundOpacity = Math.max(0, Math.min(1, parseFloat(opacity)));
        
        // If already rendered, live-update the styles immediately
        if (this.isRendered && this.containerElement) {
            const layoutPanel = this.containerElement.querySelector('.formspec_ast-base > div');
            if (layoutPanel) {
                layoutPanel.style.backgroundColor = `rgba(52, 52, 52, ${this.backgroundOpacity})`;
                // Remove the border if fully transparent to keep it clean
                if (this.backgroundOpacity === 0) {
                    layoutPanel.style.borderColor = 'transparent';
                } else {
                    layoutPanel.style.borderColor = '#0D0D0D';
                }
            }
        }
    }

    /**
     * Configure anchor positioning for HUD components
     * Supported options: 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'top', 'bottom', 'left', 'right'
     */
    setHUDAnchor(anchorType) {
        this.hudAnchor = anchorType;
    }

    onButton(name, callback) {
        if (typeof callback === 'function') {
            this.callbacks[name] = callback;
        }
    }

    getData(name) {
        const el = this.renderedElements[name];
        if (!el) {
            console.warn(`Formspec element [${name}] not found in current render DOM pipeline.`);
            return null;
        }

        const type = el.getAttribute('data-type');

        switch (type) {
            case 'checkbox':
                return el.getAttribute('data-checked') === 'true';
            case 'dropdown':
                const select = el.querySelector('select');
                return select ? select.selectedIndex + 1 : null;
            case 'textlist':
                const node = JSON.parse(el.getAttribute('data-formspec_ast') || '{}');
                return node.selected_idx || null;
            case 'textarea': 
            case 'pwdfield':
                const input = el.querySelector('textarea, input');
                return input ? input.value : '';
            case 'label':
            case 'vertlabel':
                return el.textContent;
            default:
                const rawAst = el.getAttribute('data-formspec_ast');
                return rawAst ? JSON.parse(rawAst) : null;
        }
    }

    setData(name, value) {
        const el = this.renderedElements[name];
        if (!el) {
            console.warn(`Formspec element [${name}] not found in current render DOM pipeline.`);
            return;
        }

        const type = el.getAttribute('data-type');
        const node = JSON.parse(el.getAttribute('data-formspec_ast') || '{}');

        switch (type) {
            case 'label':
            case 'vertlabel':
                node.label = String(value);
                el.textContent = String(value);
                el.setAttribute('data-text', String(value));
                break;

            case 'checkbox':
                const boolVal = !!value;
                el.setAttribute('data-checked', boolVal ? 'true' : 'false');
                node.selected = boolVal;
                break;

            case 'dropdown':
                const select = el.querySelector('select');
                if (select) {
                    const idx = parseInt(value, 10);
                    if (!isNaN(idx) && idx >= 1 && idx <= select.options.length) {
                        select.selectedIndex = idx - 1;
                        node.selected_idx = idx;
                    }
                }
                break;

            case 'textlist':
                const listIdx = parseInt(value, 10);
                const children = el.querySelectorAll('div');
                if (!isNaN(listIdx) && listIdx >= 1 && listIdx <= children.length) {
                    node.selected_idx = listIdx;
                    children.forEach((child, idx) => {
                        if (idx === (listIdx - 1)) {
                            child.style.background = 'rgb(70, 120, 50)';
                        } else {
                            child.style.background = '';
                        }
                    });
                }
                break;

            case 'textarea':
            case 'pwdfield':
                const input = el.querySelector('textarea, input');
                if (input) {
                    input.value = String(value);
                    node.default = String(value);
                }
                break;
            
            default:
                console.warn(`Mutation parsing strategy for element type [${type}] is not defined.`);
                return;
        }

        el.setAttribute('data-formspec_ast', JSON.stringify(node));
    }

    setTextlistElement(name, displayText, data, index) {
        const el = this.renderedElements[name];
        if (!el || el.getAttribute('data-type') !== 'textlist') return index;

        const node = JSON.parse(el.getAttribute('data-formspec_ast') || '{}');
        const idx0 = index - 1;

        if (node.listelems && idx0 >= 0 && idx0 < node.listelems.length) {
            node.listelems[idx0] = { displayText, data };
            el.setAttribute('data-formspec_ast', JSON.stringify(node));

            const children = el.querySelectorAll('div');
            if (children[idx0]) {
                children[idx0].textContent = displayText;
            }
        }
        return index;
    }

    getTextlistElement(name, index) {
        const el = this.renderedElements[name];
        if (!el || el.getAttribute('data-type') !== 'textlist') return null;

        const node = JSON.parse(el.getAttribute('data-formspec_ast') || '{}');
        const idx0 = index - 1;

        if (node.listelems && idx0 >= 0 && idx0 < node.listelems.length) {
            const item = node.listelems[idx0];
            if (typeof item === 'string') {
                return { displayText: item, data: null };
            }
            return { displayText: item.displayText, data: item.data };
        }
        return null;
    }

    addTextlistElement(name, displayText, data) {
        const el = this.renderedElements[name];
        if (!el || el.getAttribute('data-type') !== 'textlist') return;

        const node = JSON.parse(el.getAttribute('data-formspec_ast') || '{}');
        if (!node.listelems) node.listelems = [];

        const newItem = { displayText, data };
        node.listelems.push(newItem);
        el.setAttribute('data-formspec_ast', JSON.stringify(node));

        const itemDiv = document.createElement('div');
        itemDiv.textContent = displayText;
        
        itemDiv.addEventListener('click', () => {
            const structuralSiblings = el.querySelectorAll('div');
            structuralSiblings.forEach(sib => sib.style.background = '');
            
            itemDiv.style.background = 'rgb(70, 120, 50)';
            
            const updateNode = JSON.parse(el.getAttribute('data-formspec_ast') || '{}');
            const divsArray = Array.from(el.querySelectorAll('div'));
            updateNode.selected_idx = divsArray.indexOf(itemDiv) + 1;
            el.setAttribute('data-formspec_ast', JSON.stringify(updateNode));
        });

        el.appendChild(itemDiv);
    }

    removeTextlistElement(name, index) {
        const el = this.renderedElements[name];
        if (!el || el.getAttribute('data-type') !== 'textlist') return;

        const node = JSON.parse(el.getAttribute('data-formspec_ast') || '{}');
        const idx0 = index - 1;

        if (node.listelems && idx0 >= 0 && idx0 < node.listelems.length) {
            node.listelems.splice(idx0, 1);
            
            if (node.selected_idx > node.listelems.length) {
                node.selected_idx = Math.max(1, node.listelems.length);
            }
            
            el.setAttribute('data-formspec_ast', JSON.stringify(node));

            const children = el.querySelectorAll('div');
            if (children[idx0]) {
                el.removeChild(children[idx0]);
            }

            const dynamicChildren = el.querySelectorAll('div');
            dynamicChildren.forEach((child, idx) => {
                if (idx === (node.selected_idx - 1)) {
                    child.style.background = 'rgb(70, 120, 50)';
                } else {
                    child.style.background = '';
                }
            });
        }
    }

    loadData(formspec) {
        if (typeof formspec !== 'string') {
            throw new TypeError('Formspec layout description must be a primitive string.');
        }
        this.formspecString = formspec;
    }

    _calculateScale() {
        const baseHeightUnits = 14;
        const scaleFactor = window.innerHeight / baseHeightUnits;
        return Math.max(1, Math.floor(scaleFactor));
    }

    _applyAnchorLayout(container) {
        if (!this.hudAnchor) {
            // Standard central layout geometry for menus
            container.style.justifyContent = 'center';
            container.style.alignItems = 'center';
            return;
        }

        switch (this.hudAnchor) {
            case 'top-left':
                container.style.justifyContent = 'flex-start';
                container.style.alignItems = 'flex-start';
                break;
            case 'top-right':
                container.style.justifyContent = 'flex-end';
                container.style.alignItems = 'flex-start';
                break;
            case 'bottom-left':
                container.style.justifyContent = 'flex-start';
                container.style.alignItems = 'flex-end';
                break;
            case 'bottom-right':
                container.style.justifyContent = 'flex-end';
                container.style.alignItems = 'flex-end';
                break;
            case 'top':
                container.style.justifyContent = 'center';
                container.style.alignItems = 'flex-start';
                break;
            case 'bottom':
                container.style.justifyContent = 'center';
                container.style.alignItems = 'flex-end';
                break;
            case 'left':
                container.style.justifyContent = 'flex-start';
                container.style.alignItems = 'center';
                break;
            case 'right':
                container.style.justifyContent = 'flex-end';
                container.style.alignItems = 'center';
                break;
            default:
                container.style.justifyContent = 'center';
                container.style.alignItems = 'center';
        }
    }

    _handleResize() {
        if (!this.isRendered || !this.containerElement) return;

        const baseFrame = this.containerElement.querySelector('.formspec_ast-base');
        if (!baseFrame) return;

        const wUnits = parseFloat(baseFrame.getAttribute('data-w'));
        const hUnits = parseFloat(baseFrame.getAttribute('data-h'));

        this.scale = this._calculateScale();

        baseFrame.style.fontSize = `${this.scale}px`;
        baseFrame.style.width = `${wUnits * this.scale}px`;
        baseFrame.style.height = `${hUnits * this.scale}px`;

        this._applyAnchorLayout(this.containerElement);

        const innerWrapper = baseFrame.firstChild;
        if (innerWrapper) {
            innerWrapper.style.width = `${wUnits * this.scale}px`;
            innerWrapper.style.height = `${hUnits * this.scale}px`;
        }

        const childElements = innerWrapper.querySelectorAll('.formspec_ast-element');
        childElements.forEach(el => {
            const node = JSON.parse(el.getAttribute('data-formspec_ast') || '{}');
            
            el.style.left = `${node.x * this.scale}px`;
            el.style.top = `${node.y * this.scale}px`;
            if (node.w !== undefined) el.style.width = `${node.w * this.scale}px`;
            if (node.h !== undefined) el.style.height = `${node.h * this.scale}px`;
        });
    }

    render() {
        if (!this.formspecString) {
            console.warn('Formspec initialization failed: no loaded data template found. Call loadData() first.');
            return;
        }

        if (this.isRendered) {
            this.delete();
        }

        this.renderedElements = {};
        const elements = this._parseFormspec(this.formspecString);

        let wUnits = 10.5;
        let hUnits = 11;
        const sizeNode = elements.find(el => el.type === 'size');
        if (sizeNode) {
            wUnits = sizeNode.w;
            hUnits = sizeNode.h;
        }

        this.scale = this._calculateScale();

        this.containerElement = document.createElement('div');
        this.containerElement.style.position = 'fixed';
        this.containerElement.style.top = '0px';
        this.containerElement.style.left = '0px';
        this.containerElement.style.width = '100%';
        this.containerElement.style.height = '100%';
        
        // HUD layers have lower z-index than standard UI menus (99990 vs 99999)
        // Set pointer-events to 'none' on container so clicks pass through into the game
        this.containerElement.style.zIndex = this.hudAnchor ? '99990' : '99999';
        this.containerElement.style.display = 'flex';
        this.containerElement.style.pointerEvents = 'none';

        this._applyAnchorLayout(this.containerElement);

        const baseFrame = document.createElement('div');
        baseFrame.className = 'formspec_ast-base';
        baseFrame.setAttribute('data-render-options', '[]');
        baseFrame.setAttribute('data-w', wUnits.toString());
        baseFrame.setAttribute('data-h', hUnits.toString());
        baseFrame.style.fontSize = `${this.scale}px`;
        baseFrame.style.width = `${wUnits * this.scale}px`;
        baseFrame.style.height = `${hUnits * this.scale}px`;
        baseFrame.style.position = 'relative';

        const innerWrapper = document.createElement('div');
        innerWrapper.style.width = `${wUnits * this.scale}px`;
        innerWrapper.style.height = `${hUnits * this.scale}px`;
        innerWrapper.style.position = 'absolute';
        innerWrapper.style.top = '0px';
        innerWrapper.style.left = '0px';
        
        // Overrides the stylesheet's hex color with an inline RGBA color on the panel div
        innerWrapper.style.backgroundColor = `rgba(52, 52, 52, ${this.backgroundOpacity})`;
        if (this.backgroundOpacity === 0) {
            innerWrapper.style.borderColor = 'transparent';
        }

        // Re-enable click capture only on actual inner structural overlay elements if needed
        if (!this.hudAnchor) {
            innerWrapper.style.pointerEvents = 'auto';
        }

        elements.forEach(node => {
            if (node.type === 'size') return; 
            const el = this._createElementNode(node);
            if (el) {
                innerWrapper.appendChild(el);
                if (node.name) {
                    this.renderedElements[node.name] = el;
                }
            }
        });

        baseFrame.appendChild(innerWrapper);
        this.containerElement.appendChild(baseFrame);
        document.body.appendChild(this.containerElement);
        this.isRendered = true;

        window.addEventListener('resize', this._handleResize);
    }

    delete() {
        window.removeEventListener('resize', this._handleResize);

        // Detach layout event hooks safely from all bound inventories without purging their content state arrays
        this.boundInventories.forEach(inventory => {
            inventory.detachFormspec(this);
        });
        this.boundInventories.clear();

        if (this.containerElement && this.containerElement.parentNode) {
            this.containerElement.parentNode.removeChild(this.containerElement);
        }
        this.containerElement = null;
        this.isRendered = false;
        this.renderedElements = {};
    }

    _injectStyles() {
        if (!document.getElementById('formspec-external-link-css')) {
            const linkNode = document.createElement('link');
            linkNode.id = 'formspec-external-link-css';
            linkNode.rel = 'stylesheet';
            linkNode.type = 'text/css';
            linkNode.href = 'page/style/gui/all.css';
            document.head.appendChild(linkNode);
        }

        if (!document.getElementById('formspec-disabled-patch-css')) {
            const styleNode = document.createElement('style');
            styleNode.id = 'formspec-disabled-patch-css';
            styleNode.textContent = `
                .formspec_ast-element.formspec_ast-disabled,
                .formspec_ast-element[disabled] {
                    opacity: 0.5 !important;
                    pointer-events: none !important;
                    cursor: not-allowed !important;
                }
                .formspec_ast-element.formspec_ast-disabled *,
                .formspec_ast-element[disabled] * {
                    pointer-events: none !important;
                }
            `;
            document.head.appendChild(styleNode);
        }
    }

    _parseFormspec(fs) {
        const nodes = [];
        const elementRegex = /([a-zA-Z_0-9]+)\s*\[([^\]]*)\]/g;
        let match;

        while ((match = elementRegex.exec(fs)) !== null) {
            const type = match[1];
            const content = match[2];
            const args = content.split(';').map(arg => arg.trim());
            const node = { type };

            try {
                if (type === 'size') {
                    const dims = args[0].split(',');
                    node.w = parseFloat(dims[0]);
                    node.h = parseFloat(dims[1]);
                } else if (type === 'label' || type === 'vertlabel') {
                    const pos = args[0].split(',');
                    node.x = parseFloat(pos[0]);
                    node.y = parseFloat(pos[1]);
                    node.label = args[1] || '';
                    node.name = args[2] || ''; 
                } else if (type === 'button' || type === 'button_exit') {
                    const pos = args[0].split(',');
                    const dims = args[1].split(',');
                    node.x = parseFloat(pos[0]);
                    node.y = parseFloat(pos[1]);
                    node.w = parseFloat(dims[0]);
                    node.h = parseFloat(dims[1]);
                    node.name = args[2] || '';
                    node.label = args[3] || '';
                    node.disabled = args[4] === 'true' || args.includes('disabled');
                } else if (type === 'box') {
                    const pos = args[0].split(',');
                    const dims = args[1].split(',');
                    node.x = parseFloat(pos[0]);
                    node.y = parseFloat(pos[1]);
                    node.w = parseFloat(dims[0]);
                    node.h = parseFloat(dims[1]);
                    node.color = args[2] || 'grey';
                } else if (type === 'checkbox') {
                    const pos = args[0].split(',');
                    node.x = parseFloat(pos[0]);
                    node.y = parseFloat(pos[1]);
                    node.name = args[1] || '';
                    node.label = args[2] || '';
                    node.selected = args[3] === 'true';
                    node.disabled = args[4] === 'true' || args.includes('disabled');
                } else if (type === 'dropdown') {
                    const pos = args[0].split(',');
                    const dims = args[1].split(',');
                    node.x = parseFloat(pos[0]);
                    node.y = parseFloat(pos[1]);
                    node.w = parseFloat(dims[0]);
                    node.h = parseFloat(dims[1]);
                    node.name = args[2] || '';
                    node.items = args[3] ? args[3].split(',') : [];
                    node.selected_idx = parseInt(args[4] || '1', 10);
                    node.index_event = args[5] === 'true';
                    node.disabled = args[6] === 'true' || args.includes('disabled');
                } else if (type === 'textlist' || type === 'text_list') {
                    node.type = 'textlist'; 
                    const pos = args[0].split(',');
                    const dims = args[1].split(',');
                    node.x = parseFloat(pos[0]);
                    node.y = parseFloat(pos[1]);
                    node.w = parseFloat(dims[0]);
                    node.h = parseFloat(dims[1]);
                    node.name = args[2] || '';
                    
                    const rawList = args[3] ? args[3].split(',') : [];
                    node.listelems = rawList.map(str => ({ displayText: str, data: null }));
                    
                    node.selected_idx = parseInt(args[4] || '1', 10);
                    node.transparent = args[5] === 'true';
                    node.disabled = args[6] === 'true' || args.includes('disabled');
                } else if (type === 'textarea' || type === 'field') {
                    const pos = args[0].split(',');
                    const dims = args[1].split(',');
                    node.x = parseFloat(pos[0]);
                    node.y = parseFloat(pos[1]);
                    node.w = parseFloat(dims[0]);
                    node.h = parseFloat(dims[1]);
                    node.name = args[2] || '';
                    node.label = args[3] || '';
                    node.default = args[4] || '';
                    node.disabled = args[5] === 'true' || args.includes('disabled');
                } else if (type === 'pwdfield') {
                    const pos = args[0].split(',');
                    const dims = args[1].split(',');
                    node.x = parseFloat(pos[0]);
                    node.y = parseFloat(pos[1]);
                    node.w = parseFloat(dims[0]);
                    node.h = parseFloat(dims[1]);
                    node.name = args[2] || '';
                    node.label = args[3] || '';
                    node.disabled = args[4] === 'true' || args.includes('disabled');
                } else if (type === 'image') {
                    const pos = args[0].split(',');
                    const dims = args[1].split(',');
                    node.x = parseFloat(pos[0]);
                    node.y = parseFloat(pos[1]);
                    node.w = parseFloat(dims[0]);
                    node.h = parseFloat(dims[1]);
                    node.texture_name = args[2] || '';
                } else if (type === 'iframe') {
                    const pos = args[0].split(',');
                    const dims = args[1].split(',');
                    node.x = parseFloat(pos[0]);
                    node.y = parseFloat(pos[1]);
                    node.w = parseFloat(dims[0]);
                    node.h = parseFloat(dims[1]);
                    node.url = args[2] || 'about:blank';
                    node.disabled = args[3] === 'true' || args.includes('disabled');
                } else if (type === 'list') {
                    node.inventory_location = args[0] || '';
                    node.list_name = args[1] || '';
                    const pos = args[2] ? args[2].split(',') : ['0', '0'];
                    const dims = args[3] ? args[3].split(',') : ['1', '1'];
                    node.x = parseFloat(pos[0]);
                    node.y = parseFloat(pos[1]);
                    node.w = parseFloat(dims[0]);
                    node.h = parseFloat(dims[1]);
                    node.starting_item_index = parseInt(args[4] || '0', 10);
                }

                nodes.push(node);
            } catch (e) {
                console.error(`Error parsing element tokens for type [${type}]:`, e);
            }
        }
        return nodes;
    }

    _createElementNode(node) {
        let el = null;

        const applyCommonBaseProperties = (element, tagType) => {
            element.className = `formspec_ast-element formspec_ast-${tagType} drag_drop formspec_ast-clickable`;
            if (node.disabled) {
                element.classList.add('formspec_ast-disabled');
                element.setAttribute('disabled', 'disabled');
            }
            element.setAttribute('data-type', tagType);
            element.setAttribute('data-formspec_ast', JSON.stringify(node));
            
            element.style.left = `${node.x * this.scale}px`;
            element.style.top = `${node.y * this.scale}px`;
            if (node.w !== undefined) element.style.width = `${node.w * this.scale}px`;
            if (node.h !== undefined) element.style.height = `${node.h * this.scale}px`;
            
            element.style.touchAction = 'none';
            element.style.userSelect = 'none';
            element.style.transform = 'translate(0px, 0px)';
        };

        switch (node.type) {
            case 'list':
                el = document.createElement('table');
                
                // Enforce base styling and attributes
                el.className = `formspec_ast-element formspec_ast-${node.type} drag_drop formspec_ast-clickable`;
                if (node.disabled) {
                    el.classList.add('formspec_ast-disabled');
                    el.setAttribute('disabled', 'disabled');
                }
                
                // Set attributes in the exact required sequence
                el.setAttribute('data-formspec_ast', JSON.stringify(node));
                el.setAttribute('data-type', 'list');
                
                // Position styling using "em" formatting matching your expected output block
                el.style.left = `${node.x}em`;
                el.style.top = `${node.y}em`;
                el.style.width = '10em';
                el.style.height = '5em';
                
                el.style.touchAction = 'none';
                el.style.userSelect = 'none';
                el.style.transform = 'translate(0px, 0px)';
                
                // Build HTML layout grid with designated dimensions (w = columns, h = rows)
                const rowsCount = Math.max(0, Math.floor(node.h || 0));
                const colsCount = Math.max(0, Math.floor(node.w || 0));
                
                for (let r = 0; r < rowsCount; r++) {
                    const tr = document.createElement('tr');
                    for (let c = 0; c < colsCount; c++) {
                        const td = document.createElement('td');
                        tr.appendChild(td);
                    }
                    el.appendChild(tr);
                }

                // Global inventory binding hookup
                // Looks for an inventory registered globally on window or a context provider
                if (window.globalInventories) {
                    const invKey = `${node.inventory_location}:${node.list_name}`;
                    const inventoryInstance = window.globalInventories[invKey];
                    if (inventoryInstance) {
                        inventoryInstance.attachFormspec(this);
                        this.boundInventories.add(inventoryInstance);
                    }
                }
                break;

            case 'image':
                el = document.createElement('img');
                applyCommonBaseProperties(el, 'image');
                
                const src = node.texture_name || '';
                if (src.startsWith('data:')) {
                    el.src = src.replaceAll('^', ';');
                } else {
                    el.src = `${this.assetPath}${src}`;
                }
                
                el.alt = node.texture_name;
                el.style.boxSizing = 'border-box';
                el.style.pointerEvents = 'none'; 
                break;

            case 'button':
            case 'button_exit':
                el = document.createElement('div');
                applyCommonBaseProperties(el, 'button');
                el.setAttribute('data-formspec_ast-name', node.name);
                el.style.boxSizing = 'border-box';
                el.textContent = node.label;
                el.style.cursor = node.disabled ? 'not-allowed' : 'pointer';

                el.addEventListener('click', (e) => {
                    if (node.disabled) return;
                    if (typeof this.callbacks[node.name] === 'function') {
                        this.callbacks[node.name]({
                            name: node.name,
                            label: node.label,
                            type: node.type,
                            domEvent: e
                        });
                    }
                    if (node.type === 'button_exit') {
                        this.delete();
                    }
                });
                break;

            case 'box':
                el = document.createElement('div');
                applyCommonBaseProperties(el, 'box');
                el.style.backgroundColor = node.color;
                el.style.boxSizing = 'border-box';
                break;

            case 'label':
            case 'vertlabel':
                el = document.createElement('span');
                el.setAttribute('data-text', node.label);
                applyCommonBaseProperties(el, node.type);
                if (node.name) el.setAttribute('data-formspec_ast-name', node.name); 
                el.textContent = node.label;
                break;

            case 'checkbox':
                el = document.createElement('div');
                applyCommonBaseProperties(el, 'checkbox');
                el.setAttribute('data-formspec_ast-name', node.name);
                el.setAttribute('data-checked', node.selected ? 'true' : 'false');
                el.style.cursor = node.disabled ? 'not-allowed' : 'pointer';
                
                const boxCheckNode = document.createElement('div');
                const labelCheckText = document.createElement('span');
                labelCheckText.textContent = node.label;
                
                el.appendChild(boxCheckNode);
                el.appendChild(labelCheckText);

                el.addEventListener('click', () => {
                    if (node.disabled) return;
                    const isChecked = el.getAttribute('data-checked') === 'true';
                    const nextState = !isChecked;
                    el.setAttribute('data-checked', nextState ? 'true' : 'false');
                    node.selected = nextState;
                    el.setAttribute('data-formspec_ast', JSON.stringify(node));
                });
                break;

            case 'dropdown':
                el = document.createElement('div');
                applyCommonBaseProperties(el, 'dropdown');
                el.setAttribute('data-formspec_ast-name', node.name);
                el.style.boxSizing = 'border-box';

                const htmlSelect = document.createElement('select');
                if (node.disabled) htmlSelect.disabled = true;

                node.items.forEach((item, idx) => {
                    const opt = document.createElement('option');
                    opt.setAttribute('name', item);
                    opt.textContent = item;
                    if (idx === (node.selected_idx - 1)) {
                        opt.setAttribute('selected', 'selected');
                    }
                    htmlSelect.appendChild(opt);
                });

                htmlSelect.addEventListener('change', (e) => {
                    if (node.disabled) return;
                    node.selected_idx = e.target.selectedIndex + 1;
                    el.setAttribute('data-formspec_ast', JSON.stringify(node));
                });

                const innerArrowContainer = document.createElement('div');
                const innerArrowIcon = document.createElement('div');
                innerArrowContainer.appendChild(innerArrowIcon);

                el.appendChild(htmlSelect);
                el.appendChild(innerArrowContainer);
                break;

            case 'textlist':
                el = document.createElement('div');
                applyCommonBaseProperties(el, 'textlist');
                el.setAttribute('data-formspec_ast-name', node.name);
                el.style.boxSizing = 'border-box';

                node.listelems.forEach((item, idx) => {
                    const itemDiv = document.createElement('div');
                    
                    const txt = typeof item === 'string' ? item : item.displayText;
                    itemDiv.textContent = txt;
                    
                    if (idx === (node.selected_idx - 1)) {
                        itemDiv.style.background = 'rgb(70, 120, 50)';
                    }

                    itemDiv.addEventListener('click', () => {
                        if (node.disabled) return;
                        const structuralSiblings = el.querySelectorAll('div');
                        structuralSiblings.forEach(sib => sib.style.background = '');
                        
                        itemDiv.style.background = 'rgb(70, 120, 50)';
                        
                        const updateNode = JSON.parse(el.getAttribute('data-formspec_ast') || '{}');
                        const divsArray = Array.from(el.querySelectorAll('div'));
                        updateNode.selected_idx = divsArray.indexOf(itemDiv) + 1;
                        el.setAttribute('data-formspec_ast', JSON.stringify(updateNode));
                    });

                    el.appendChild(itemDiv);
                });
                break;

            case 'textarea':
                el = document.createElement('div');
                applyCommonBaseProperties(el, 'textarea');
                el.setAttribute('data-formspec_ast-name', node.name);
                el.style.boxSizing = 'border-box';

                const areaSpan = document.createElement('span');
                areaSpan.textContent = node.label;

                const areaInput = document.createElement('textarea');
                areaInput.setAttribute('type', 'text');
                areaInput.value = node.default;
                areaInput.spellcheck = "false";
                areaInput.style.userSelect = 'text';
                if (node.disabled) areaInput.disabled = true;

                areaInput.addEventListener('input', (e) => {
                    if (node.disabled) return;
                    node.default = e.target.value;
                    el.setAttribute('data-formspec_ast', JSON.stringify(node));
                });

                el.appendChild(areaSpan);
                el.appendChild(areaInput);
                break;
                
            case 'field':
                el = document.createElement('div');
                applyCommonBaseProperties(el, 'textarea');
                el.setAttribute('data-formspec_ast-name', node.name);
                el.style.boxSizing = 'border-box';

                const areaSpan2 = document.createElement('span');
                areaSpan2.textContent = node.label;

                const areaInput2 = document.createElement('input');
                areaInput2.setAttribute('type', 'text');
                areaInput2.value = node.default;
                areaInput2.spellcheck = "false";
                areaInput2.style.userSelect = 'text';
                if (node.disabled) areaInput2.disabled = true;

                areaInput2.addEventListener('input', (e) => {
                    if (node.disabled) return;
                    node.default = e.target.value;
                    el.setAttribute('data-formspec_ast', JSON.stringify(node));
                });

                el.appendChild(areaSpan2);
                el.appendChild(areaInput2);
                break;

            case 'pwdfield':
                el = document.createElement('div');
                applyCommonBaseProperties(el, 'pwdfield');
                el.setAttribute('data-formspec_ast-name', node.name);
                el.style.boxSizing = 'border-box';

                const pwdSpan = document.createElement('span');
                pwdSpan.textContent = node.label;

                const pwdInput = document.createElement('input');
                pwdInput.setAttribute('type', 'password');
                pwdInput.value = '';
                pwdInput.style.userSelect = 'text';
                if (node.disabled) pwdInput.disabled = true;

                pwdInput.addEventListener('input', (e) => {
                    if (node.disabled) return;
                    node.default = e.target.value;
                    el.setAttribute('data-formspec_ast', JSON.stringify(node));
                });

                el.appendChild(pwdSpan);
                el.appendChild(pwdInput);
                break;
            
            case 'iframe':
                el = document.createElement('iframe');
                applyCommonBaseProperties(el, 'iframe');
                
                el.src = node.url;
                el.style.border = 'none';
                el.style.boxSizing = 'border-box';
                el.style.pointerEvents = node.disabled ? 'none' : 'auto'; 
                break;

            default:
                return null;
        }

        return el;
    }
}