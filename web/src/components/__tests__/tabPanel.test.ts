import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import TabPanel from '@/components/common/TabPanel.vue'

describe('TabPanel', () => {
  it('renders slot content when active', async () => {
    const wrapper = mount(TabPanel, {
      props: { tabId: 'chat', activeTab: 'chat' },
      slots: { default: '<div class="inner">Hello</div>' },
    })

    await nextTick()

    // TabPanel with immediate:true on the watch means everOpened is set on mount if active
    expect(wrapper.find('.inner').text()).toBe('Hello')
  })

  it('shows content when active and hides when inactive', async () => {
    const wrapper = mount(TabPanel, {
      props: { tabId: 'chat', activeTab: 'chat' },
      slots: { default: '<div class="inner">Hello</div>' },
    })

    await nextTick()

    // Active
    expect(wrapper.find('.tab-panel').classes()).toContain('tab-panel-active')

    // Switch to inactive
    await wrapper.setProps({ activeTab: 'files' })
    await nextTick()

    expect(wrapper.find('.tab-panel').classes()).not.toContain('tab-panel-active')
  })

  it('lazy-mounts content after first activation (everOpened)', async () => {
    const wrapper = mount(TabPanel, {
      props: { tabId: 'chat', activeTab: 'files' },
      slots: { default: '<div class="inner">Content</div>' },
    })

    await nextTick()

    // Initially inactive — v-if="everOpened" prevents rendering
    expect(wrapper.find('.inner').exists()).toBe(false)

    // Activate the tab
    await wrapper.setProps({ activeTab: 'chat' })
    await nextTick()

    // Now the content should be rendered
    expect(wrapper.find('.inner').exists()).toBe(true)
    expect(wrapper.find('.inner').text()).toBe('Content')

    // Deactivate again — content should still be in DOM (everOpened stays true)
    await wrapper.setProps({ activeTab: 'files' })
    await nextTick()

    expect(wrapper.find('.inner').exists()).toBe(true)
  })

  it('shows header when noHeader is false (default)', async () => {
    const wrapper = mount(TabPanel, {
      props: { tabId: 'chat', activeTab: 'chat', title: 'My Tab' },
    })

    await nextTick()

    expect(wrapper.find('.bs-header').exists()).toBe(true)
    expect(wrapper.find('.bs-title').text()).toBe('My Tab')
  })

  it('hides header when noHeader is true', async () => {
    const wrapper = mount(TabPanel, {
      props: { tabId: 'chat', activeTab: 'chat', title: 'My Tab', noHeader: true },
    })

    await nextTick()

    expect(wrapper.find('.bs-header').exists()).toBe(false)
  })

  it('uses header slot when provided', async () => {
    const wrapper = mount(TabPanel, {
      props: { tabId: 'chat', activeTab: 'chat' },
      slots: { header: '<span class="custom-header">Custom</span>' },
    })

    await nextTick()

    expect(wrapper.find('.custom-header').text()).toBe('Custom')
  })

  it('emits header-click when header is clicked', async () => {
    const wrapper = mount(TabPanel, {
      props: { tabId: 'chat', activeTab: 'chat' },
    })

    await nextTick()

    await wrapper.find('.bs-header').trigger('click')

    expect(wrapper.emitted('header-click')).toBeTruthy()
    expect(wrapper.emitted('header-click')).toHaveLength(1)
  })

  it('renders footer slot when provided', async () => {
    const wrapper = mount(TabPanel, {
      props: { tabId: 'chat', activeTab: 'chat' },
      slots: { footer: '<button class="footer-btn">OK</button>' },
    })

    await nextTick()

    expect(wrapper.find('.bs-footer').exists()).toBe(true)
    expect(wrapper.find('.footer-btn').text()).toBe('OK')
  })

  it('does not render footer slot when not provided', async () => {
    const wrapper = mount(TabPanel, {
      props: { tabId: 'chat', activeTab: 'chat' },
    })

    await nextTick()

    expect(wrapper.find('.bs-footer').exists()).toBe(false)
  })

  it('toggles active class when activeTab changes', async () => {
    const wrapper = mount(TabPanel, {
      props: { tabId: 'chat', activeTab: 'chat' },
      slots: { default: '<div>Content</div>' },
    })

    await nextTick()

    expect(wrapper.find('.tab-panel').classes()).toContain('tab-panel-active')

    // Deactivate
    await wrapper.setProps({ activeTab: 'files' })
    expect(wrapper.find('.tab-panel').classes()).not.toContain('tab-panel-active')
  })
})
